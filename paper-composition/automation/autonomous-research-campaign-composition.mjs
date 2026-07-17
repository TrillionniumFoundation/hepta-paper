import {
  composeAutonomousResearchReadiness,
  createAutonomousResearchAdmissionPreflightSandbox,
  createAutonomousResearchMachineIntakeActionFence,
  attachAutonomousResearchReadinessFailure,
  inspectAutonomousResearchCampaignReleaseAttestor,
  inspectAutonomousResearchProductionAdmissionReadiness, verifyAutonomousResearchSupervisorReadinessAuthorization,
} from './autonomous-research-readiness-composition.mjs';
import { composeCampaignWorkerExecution } from './campaign-worker-composition.mjs';
import { bootstrapCampaignExecutionContext } from '../bootstrap/campaign-execution-context-bootstrap.mjs';
import { createAutonomousResearchWorkspaceRepository } from '../../paper-adapters/automation/autonomous-research-workspace-repository.mjs';
import { createAutonomousResearchQualificationStateRepository } from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import { createFullResearchQualificationReceiptPointerRepository } from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import { materializeAutonomousResearchWorkspace } from '../../paper-adapters/automation/autonomous-research-workspace-materializer.mjs';
import { inspectResearchExecutionReleaseAttestorConfiguration } from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import {
  createExternalResearchQualificationProcessAdapter,
  inspectExternalResearchQualificationProcessConfiguration,
} from '../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import { createAutonomousResearchQualificationContextProvider } from './autonomous-research-qualification-context.mjs';
import { queryAutomationReadiness } from './automation-readiness-query.mjs';
import {
  AUTONOMOUS_RESEARCH_LAUNCH_MODES,
  evaluateAutonomousResearchLaunchModeGate,
  resolvePersistedAutonomousResearchLaunchMode,
  resolveAutonomousResearchProviderPricing,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import { verifyAutonomousResearchMachineIntake } from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import { verifyAutonomousResearchMachineIntakeAdmission } from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import { issueAutonomousResearchSupervisorDispatchAuthorization } from '../../paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs';
import { autonomousResearchCampaignRuntimeOptions, autonomousResearchReadinessInspectionTime, createGoldenCampaignQualificationController, prepareAutonomousResearchSupervisorReadinessAction, trustedAutonomousResearchReadinessInspectionTime } from './autonomous-research-supervisor-external-action-composition.mjs';
import {
  buildAutonomousResearchCampaignPlan,
  enqueuePreparedAutonomousResearchCampaign,
  executeAutonomousResearchCampaign,
} from '../../paper-application/automation/autonomous-research-campaign.mjs';
import {
  campaignWorkerOptions,
  composeAutonomousResearchQualificationRenewal,
  configuredMaximumCost,
  providerBoundReadinessEnvironment,
  qualificationRetryBoundToExternalCostAuthority,
  readAutonomousDatasetAuthorityReceipt,
  readCurrentRelease,
  requireAutonomousResearchProviderConfiguration,
  requireExistingProductionPricingEnvelope,
  requirePersistedAutonomousProviderConfiguration,
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-qualification-composition.mjs';
export {
  composeAutonomousResearchQualificationRenewal,
  issueAutonomousResearchSupervisorDispatchAuthorization,
  qualificationRetryBoundToExternalCostAuthority,
  requireExistingProductionPricingEnvelope,
  requirePersistedAutonomousProviderConfiguration,
};

export async function composeAutonomousResearchMachineIntakeEnqueue({
  intake,
  machineIntakeAdmission,
  root,
  runtimeRoot,
  environment = process.env,
  externalQualificationConfigPath = null,
  serviceOverrides = {},
  admissionSpawnSyncImpl = undefined,
  preflightAuthor = undefined,
  preflightReviewer = undefined,
  preflightEmpiricalRuntime = undefined,
  now = new Date(),
  clock = null,
  runtimeSignal = null,
  intakeLeaseRepository = null,
  intakeLease = null,
  residentLeaseContext = null,
  assertAutonomyCurrent = null,
  worker = {},
} = {}) {
  const currentTime = () => {
    const candidate = clock?.now ? clock.now() : now;
    const value = candidate instanceof Date ? candidate : new Date(candidate);
    if (!Number.isFinite(value.getTime())) {
      throw new Error('autonomous_research_machine_intake_clock_invalid');
    }
    return value;
  };
  const observedAt = currentTime();
  if (!verifyAutonomousResearchMachineIntake(intake)
    || !verifyAutonomousResearchMachineIntakeAdmission(machineIntakeAdmission, { intake })) {
    throw new Error('autonomous_research_machine_intake_invalid');
  }
  if (!Number.isFinite(observedAt.getTime())) {
    throw new Error('autonomous_research_machine_intake_clock_invalid');
  }
  if (runtimeSignal?.aborted) {
    throw new Error(String(runtimeSignal.reason || 'autonomous_research_machine_intake_aborted'));
  }
  const admissionCreatedAt = new Date(intake.admissionCreatedAt);
  if (!Number.isFinite(admissionCreatedAt.getTime())) {
    throw new Error('autonomous_research_machine_intake_admission_time_invalid');
  }
  const fence = createAutonomousResearchMachineIntakeActionFence({
    intake, machineIntakeAdmission, intakeLeaseRepository, intakeLease,
    residentLeaseContext, assertAutonomyCurrent, runtimeSignal, currentTime,
    productionLaunchMode: AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN,
  });
  fence({ renew: true, action: 'before_admission_preflight' });
  const admissionPreflightSandbox = createAutonomousResearchAdmissionPreflightSandbox({
    environment,
    ...(admissionSpawnSyncImpl ? { spawnSyncImpl: admissionSpawnSyncImpl } : {}),
  });
  const initialWorkerOptions = campaignWorkerOptions({
    ...worker,
    budgets: intake.budgets,
  });
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    options: initialWorkerOptions,
    environment,
  });
  requireAutonomousResearchProviderConfiguration(providerConfiguration, {
    expectedHash: intake.providerConfigurationHash,
  });
  const receiptPointerRepository = createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
  });
  let publishedPointer = null;
  try { publishedPointer = receiptPointerRepository.read(); }
  catch { publishedPointer = null; }
  const readinessEnvironment = providerBoundReadinessEnvironment({
    ...environment,
    ...(!environment.HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT && publishedPointer
      ? {
        HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT:
          receiptPointerRepository.qualificationReceiptPath,
      } : {}),
  }, providerConfiguration);
  const providerPricingInspection = resolveAutonomousResearchProviderPricing({
    researchAuthorProvider: providerConfiguration.researchAuthor.provider,
    researchAuthorModel: providerConfiguration.researchAuthor.model,
    formalReviewerProvider: providerConfiguration.formalReviewer.provider,
    formalReviewerModel: providerConfiguration.formalReviewer.model,
    researchAuthorMaximumCostPerCallUsd:
      configuredMaximumCost(readinessEnvironment, 'RESEARCH_AUTHOR'),
    formalReviewerMaximumCostPerCallUsd:
      configuredMaximumCost(readinessEnvironment, 'FORMAL_REVIEWER'),
  });
  const releaseAttestorInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    runtimeRoot,
    configPath: readinessEnvironment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG || null,
    now: currentTime(),
    environment: readinessEnvironment,
    activeVerification: false,
  });
  const productionReadiness = intake.launchMode
    === AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN
    ? inspectAutonomousResearchProductionAdmissionReadiness({
      runtimeRoot, environment: readinessEnvironment, releaseAttestorInspection,
      now: currentTime(),
    }) : null;
  const launchModeGate = evaluateAutonomousResearchLaunchModeGate({
    launchMode: intake.launchMode,
    action: 'launch',
    budgets: intake.budgets,
    providerPricingInspection,
    fullResearchReadiness: productionReadiness,
    admissionOnly: true,
  });
  if (launchModeGate.status !== 'autonomous_research_launch_mode_ready') {
    throw new Error(
      `autonomous_research_machine_intake_launch_mode_blocked:${launchModeGate.blockers.join(',')}`,
    );
  }
  fence({ action: 'before_dataset_authority_read' });
  const datasetAuthorityReceipt = readAutonomousDatasetAuthorityReceipt({
    datasetMounts: intake.datasetMounts,
    runtimeRoot,
  });
  const externalQualificationConfigurationInspection =
    inspectExternalResearchQualificationProcessConfiguration({
      configPath: externalQualificationConfigPath,
      environment: readinessEnvironment,
    });
  fence({ renew: true, action: 'before_admission_readiness' });
  const readinessReport = await composeAutonomousResearchReadiness({
    paperId: intake.paperId,
    objective: intake.objective,
    protocolFamily: intake.protocolFamily,
    revisionRounds: intake.revisionRounds,
    refereeCount: intake.refereeCount,
    humanSubjects: false,
    privateData: false,
    datasetMounts: intake.datasetMounts,
    datasetAuthorityReceipt,
    machineIntake: intake,
    machineIntakeAdmission,
    createdAt: admissionCreatedAt.toISOString(),
    environment: readinessEnvironment,
    providerConfiguration,
    expectedProviderConfigurationHash: intake.providerConfigurationHash,
    releaseAttestorInspection,
    externalQualificationConfigurationInspection,
    launchModeGate,
    providerPricingInspection,
    spawnSyncImpl: admissionPreflightSandbox.spawnSyncImpl,
    ...(preflightAuthor ? { preflightAuthor } : {}),
    ...(preflightReviewer ? { preflightReviewer } : {}),
    ...(preflightEmpiricalRuntime ? { preflightEmpiricalRuntime } : {}),
  });
  fence({ renew: true, action: 'before_workspace_materialization' });
  const execution = bootstrapCampaignExecutionContext({
    root,
    runtimeRoot,
    mode: 'autonomous-research-machine-intake-enqueue',
    execute: true,
    serviceOverrides,
  });
  const { context } = execution;
  try {
    fence({ renew: true });
    const preparation = readinessReport.loopPreparation;
    const repository = createAutonomousResearchWorkspaceRepository({
      runtimeRoot,
      paperId: preparation.proposal.paperId,
    });
    const materialization = materializeAutonomousResearchWorkspace({
      repository,
      loopPreparation: preparation,
      datasetMounts: intake.datasetMounts,
    });
    fence({ renew: true, action: 'before_campaign_enqueue_commit' });
    const enqueued = enqueuePreparedAutonomousResearchCampaign({
      readinessReport,
      campaignId: intake.campaignId,
      datasetMounts: intake.datasetMounts,
      budgets: launchModeGate.effectiveBudgets,
      machineIntake: intake,
      machineIntakeAdmission,
      admissionPreflightExecutionInspection: admissionPreflightSandbox.inspection(),
      campaignStore: context.services.campaignStore,
      preparedMaterialization: materialization,
    });
    fence({ action: 'after_campaign_enqueue_commit' });
    return enqueued;
  } finally {
    context.services.persistenceSession.close();
  }
}

export async function composeAutonomousResearchCampaignAction({
  action = 'prepare',
  launchMode = null,
  paperId = null,
  campaignId = null,
  objective = null,
  protocolFamily = null,
  root,
  runtimeRoot,
  datasetMounts = [],
  revisionRounds = 3,
  refereeCount = 3,
  budgets = {},
  humanSubjects = false,
  privateData = false,
  createdAt = null,
  environment = process.env,
  preflightAuthor = undefined,
  preflightReviewer = undefined,
  preflightEmpiricalRuntime = undefined,
  externalQualificationConfigPath = null,
  externalQualificationClient = null,
  externalQualificationVerifier = null,
  qualificationRetry = {},
  serviceOverrides = {},
  executorOverride = null,
  campaignRunner = undefined,
  productionReadinessInspector = queryAutomationReadiness,
  releaseAttestorSpawnSyncImpl = undefined,
  readinessClock = null,
  supervisorDispatchAuthorization = null,
  supervisorExternalActionJournal = null,
  runtimeSignal = null,
  worker = {},
} = {}) {
  const initialWorkerOptions = campaignWorkerOptions({ ...worker, budgets });
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    options: initialWorkerOptions,
    environment,
  });
  const providerConfigurationHash =
    providerConfiguration.autonomousResearchProviderConfigurationHash;
  const receiptPointerRepository = createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
  });
  let publishedPointer = null;
  try { publishedPointer = receiptPointerRepository.read(); }
  catch { publishedPointer = null; }
  const readinessEnvironment = providerBoundReadinessEnvironment({
    ...environment,
    ...(!environment.HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT && publishedPointer
      ? {
        HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT:
          receiptPointerRepository.qualificationReceiptPath,
      } : {}),
  }, providerConfiguration);
  const providerPricingInspection = resolveAutonomousResearchProviderPricing({
    researchAuthorProvider: providerConfiguration.researchAuthor.provider,
    researchAuthorModel: providerConfiguration.researchAuthor.model,
    formalReviewerProvider: providerConfiguration.formalReviewer.provider,
    formalReviewerModel: providerConfiguration.formalReviewer.model,
    researchAuthorMaximumCostPerCallUsd:
      configuredMaximumCost(readinessEnvironment, 'RESEARCH_AUTHOR'),
    formalReviewerMaximumCostPerCallUsd:
      configuredMaximumCost(readinessEnvironment, 'FORMAL_REVIEWER'),
  });
  const dispatchMutation = ['launch', 'resume', 'converge'].includes(action);
  const productionMutation = launchMode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN
    && dispatchMutation;
  const productionReadinessObservedAt = productionMutation
    ? trustedAutonomousResearchReadinessInspectionTime(readinessClock) : null;
  const id = action === 'prepare'
    ? null : campaignId || (paperId ? `autonomous-research:${paperId}` : null);
  if (action !== 'prepare' && !id) throw new Error('autonomous_research_campaign_id_required');
  if (productionMutation && !supervisorDispatchAuthorization) {
    throw new Error('autonomous_research_production_readiness_authorization_required');
  }
  const readOnly = action === 'status';
  let campaignExecutionContext = null;
  if (action !== 'prepare') {
    try {
      campaignExecutionContext = bootstrapCampaignExecutionContext({
        root, runtimeRoot, mode: 'autonomous-research-campaign',
        execute: !readOnly, readOnly, serviceOverrides,
      });
    } catch (error) {
      if (!String(error?.message || error).startsWith('Read-only paper store missing:')) {
        throw error;
      }
    }
  }
  let context = campaignExecutionContext?.context || null;
  let campaignStore = context?.services.campaignStore || null;
  let existing = null;
  let productionReadiness = null, releaseAttestorInspection = null,
    releaseAttestorSideEffectLedger = null, supervisorReadinessAction = null;
  try {
    existing = campaignStore?.getCampaign(id) || null;
    supervisorReadinessAction = prepareAutonomousResearchSupervisorReadinessAction({
      dispatchMutation, productionMutation, supervisorDispatchAuthorization,
      campaign: existing, campaignId: id, launchMode, action, providerConfigurationHash,
      supervisorExternalActionJournal,
      now: new Date(productionReadinessObservedAt
        || trustedAutonomousResearchReadinessInspectionTime(readinessClock)),
    });
    const supervisorProviderCanaryAuthorized = supervisorReadinessAction.authorized;
    if (productionMutation) {
      const result = await productionReadinessInspector({
        root,
        runtimeRoot,
        environment: readinessEnvironment,
        liveProviderCanaryRequested: !supervisorProviderCanaryAuthorized,
        requireFullResearch: true,
        now: new Date(productionReadinessObservedAt.getTime()),
      });
      productionReadiness = result?.report || result?.readiness || result || null;
      const sideEffectInspection = productionReadiness?.readinessSideEffectInspection || null;
      supervisorReadinessAction.finalizeSuccess({
        evidence: sideEffectInspection,
        now: new Date(productionReadinessObservedAt.getTime()),
      });
    }
    const launchModeGate = evaluateAutonomousResearchLaunchModeGate({
    launchMode,
    action,
    budgets,
    providerPricingInspection,
    fullResearchReadiness: productionReadiness,
  });
    if (launchModeGate.status !== 'autonomous_research_launch_mode_ready') {
      throw new Error(
        `autonomous_research_launch_mode_blocked:${launchModeGate.blockers.join(',')}`,
      );
    }
    const effectiveBudgets = launchModeGate.effectiveBudgets;
    const workerOptions = campaignWorkerOptions({ ...worker, budgets: effectiveBudgets });
    const datasetAuthorityReceipt = readAutonomousDatasetAuthorityReceipt({
    datasetMounts,
    runtimeRoot,
  });
    const injectedQualificationServices = Boolean(
    externalQualificationClient || externalQualificationVerifier,
  );
    if (Boolean(externalQualificationClient) !== Boolean(externalQualificationVerifier)) {
    throw new Error('autonomous_research_external_qualification_services_incomplete');
  }
    const qualificationConfigurationRequested = Boolean(
    externalQualificationConfigPath
      || environment.HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG,
  );
    if (injectedQualificationServices && qualificationConfigurationRequested) {
    throw new Error('autonomous_research_external_qualification_service_source_conflict');
  }
    ({
      inspection: releaseAttestorInspection,
      sideEffectLedger: releaseAttestorSideEffectLedger,
    } = inspectAutonomousResearchCampaignReleaseAttestor({
      productionMutation,
      productionReadiness,
      productionReadinessObservedAt,
      runtimeRoot,
      configPath: environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG || null,
      observedAt: autonomousResearchReadinessInspectionTime(createdAt),
      environment: readinessEnvironment,
      activeVerification: dispatchMutation && supervisorProviderCanaryAuthorized,
      spawnSyncImpl: releaseAttestorSpawnSyncImpl,
    }));
    if (supervisorReadinessAction.actionKind === 'golden-release-attestor') {
      const sideEffectInspection = releaseAttestorSideEffectLedger.inspection({
        releaseAttestorInspection,
      });
      supervisorReadinessAction.finalizeSuccess({
        evidence: sideEffectInspection,
        now: autonomousResearchReadinessInspectionTime(createdAt),
      });
    }
    const externalQualificationConfigurationInspection = injectedQualificationServices
    ? null
    : inspectExternalResearchQualificationProcessConfiguration({
      configPath: externalQualificationConfigPath,
      environment,
    });
    if (action === 'prepare') {
      return composeAutonomousResearchReadiness({
      paperId, objective, protocolFamily, revisionRounds, refereeCount, humanSubjects, privateData,
      datasetMounts,
      datasetAuthorityReceipt,
      createdAt, environment,
      providerConfiguration,
      expectedProviderConfigurationHash: providerConfigurationHash,
      releaseAttestorInspection,
      externalQualificationConfigurationInspection,
      externalQualificationClient,
      externalQualificationVerifier,
      launchModeGate,
      providerPricingInspection,
      ...(preflightAuthor ? { preflightAuthor } : {}),
      ...(preflightReviewer ? { preflightReviewer } : {}),
      ...(preflightEmpiricalRuntime ? { preflightEmpiricalRuntime } : {}),
      });
    }
    if (!context) {
      campaignExecutionContext = bootstrapCampaignExecutionContext({
        root, runtimeRoot, mode: 'autonomous-research-campaign',
        execute: !readOnly, readOnly, serviceOverrides,
      });
      context = campaignExecutionContext.context;
      campaignStore = context.services.campaignStore;
      existing = campaignStore.getCampaign(id);
      if (dispatchMutation) verifyAutonomousResearchSupervisorReadinessAuthorization({
        authorization: supervisorDispatchAuthorization,
        campaign: existing,
        launchMode,
        action,
        providerConfigurationHash,
        now: productionReadinessObservedAt || trustedAutonomousResearchReadinessInspectionTime(readinessClock),
      });
    }
    if (existing) {
      resolvePersistedAutonomousResearchLaunchMode({
        campaign: existing,
        requestedLaunchMode: launchMode,
      });
      requireExistingProductionPricingEnvelope({
        action,
        existingCampaign: existing,
        requestedBudgets: budgets,
        launchModeGate,
      });
    }
    const providerConfigurationBindingHash =
      requirePersistedAutonomousProviderConfiguration({
        action,
        existingCampaign: existing,
        providerConfiguration,
      });
    const legacyProviderConfigurationBindingMissing = Boolean(
      existing && !providerConfigurationBindingHash,
    );
    const configuredQualification = !legacyProviderConfigurationBindingMissing
      && !externalQualificationClient
      && qualificationConfigurationRequested
      ? createExternalResearchQualificationProcessAdapter({
        configPath: externalQualificationConfigPath,
        cwd: root,
        environment,
        clock: context.services.clock,
        fullVerificationContextProvider:
          createAutonomousResearchQualificationContextProvider({
            schemaVersionReceipt: context.services.schemaVersion,
            providerConfiguration,
            expectedProviderConfigurationHash: providerConfigurationBindingHash,
            environment,
            runtimeRoot,
          }),
      }) : null;
    const effectiveQualificationClient = legacyProviderConfigurationBindingMissing
      ? null
      : externalQualificationClient || configuredQualification?.client || null;
    const effectiveQualificationVerifier = legacyProviderConfigurationBindingMissing
      ? null
      : externalQualificationVerifier || configuredQualification?.verifier || null;
    const effectiveQualificationRetry = qualificationRetryBoundToExternalCostAuthority({
      launchMode,
      action,
      qualificationRetry,
      configurationInspection:
        configuredQualification?.inspection || externalQualificationConfigurationInspection,
      externalQualificationClient: effectiveQualificationClient,
      externalQualificationVerifier: effectiveQualificationVerifier,
    });
    let readinessReport = null;
    let materialization = null;
    let plan = existing?.spec || null;
    let qualificationStateStore = null;
    if (['launch', 'converge'].includes(action) && !existing) {
      readinessReport = await composeAutonomousResearchReadiness({
        paperId, objective, protocolFamily, revisionRounds, refereeCount, humanSubjects, privateData,
        datasetMounts,
        datasetAuthorityReceipt,
        createdAt, environment,
        providerConfiguration,
        expectedProviderConfigurationHash: providerConfigurationHash,
        releaseAttestorInspection,
        externalQualificationConfigurationInspection:
          configuredQualification?.inspection || externalQualificationConfigurationInspection,
        externalQualificationClient,
        externalQualificationVerifier,
        launchModeGate,
        providerPricingInspection,
        ...(preflightAuthor ? { preflightAuthor } : {}),
        ...(preflightReviewer ? { preflightReviewer } : {}),
        ...(preflightEmpiricalRuntime ? { preflightEmpiricalRuntime } : {}),
      });
      const preparation = readinessReport.loopPreparation;
      const repository = createAutonomousResearchWorkspaceRepository({
        runtimeRoot,
        paperId: preparation.proposal.paperId,
      });
      qualificationStateStore = createAutonomousResearchQualificationStateRepository({
        runtimeRoot,
        paperId: preparation.proposal.paperId,
      });
      materialization = materializeAutonomousResearchWorkspace({
        repository,
        loopPreparation: preparation,
        datasetMounts,
      });
      plan = buildAutonomousResearchCampaignPlan({
        loopPreparation: preparation,
        materialization,
        datasetMounts,
        campaignId: id,
        budgets: effectiveBudgets,
      });
    }
    if (!qualificationStateStore && existing && !legacyProviderConfigurationBindingMissing) {
      qualificationStateStore = createAutonomousResearchQualificationStateRepository({
        runtimeRoot,
        paperId: existing.paperId,
        create: action !== 'status',
      });
    }
    const requiresExecutor = action === 'resume'
      ? ['running', 'paused', 'stopped'].includes(existing?.status)
      : action === 'converge'
        ? !existing || ['running', 'paused', 'stopped'].includes(existing.status)
        : action === 'launch'
          && !['completed', 'failed', 'cancelled', 'paused', 'stopped']
            .includes(existing?.status);
    let executor = executorOverride;
    if (requiresExecutor && !executor) {
      const composed = composeCampaignWorkerExecution({
        options: workerOptions,
        plans: [plan],
        runtimeRoot,
        datasetMounts: plan.datasetMounts || datasetMounts,
        workspaceRegistry: context.services.workspaceRegistry,
        campaignExecutionContext,
        services: context.services,
        environment,
        providerConfiguration,
        expectedProviderConfigurationHash:
          plan.autonomousResearchPreparation
            ?.autonomousResearchProviderConfigurationHash || providerConfigurationHash,
      });
      executor = composed.nodeExecutor;
    }
    const resourceGovernor = readOnly ? null : context.services.resourceGovernorFactory({
      agent: Number(worker.agentSlots || 4),
      cpu: Number(worker.cpuSlots || 4),
      gpu: Number(worker.gpuSlots || 1),
      memoryMiB: Number(worker.memoryMiB || 8192),
    });
    const goldenQualificationController = launchMode
        === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP
      && effectiveQualificationVerifier?.kind
        === 'IndependentExternalResearchQualificationVerifier'
      && typeof effectiveQualificationVerifier.verifyLocally === 'function'
      ? createGoldenCampaignQualificationController({
        localQualificationVerifier: effectiveQualificationVerifier,
        receiptPointerRepository,
        clock: context.services.clock,
      }) : null;
    const executionReport = await executeAutonomousResearchCampaign({
      action,
      readinessReport,
      campaignId: id,
      datasetMounts,
      budgets: existing ? budgets : effectiveBudgets,
      campaignStore,
      executor,
      preparedMaterialization: materialization,
      ...(campaignRunner ? { campaignRunner } : {}),
      campaignReleaseAuthorityReader: ({ campaignId: releaseCampaignId }) => readCurrentRelease({
        root, runtimeRoot, campaignId: releaseCampaignId,
      }),
      externalQualificationClient: effectiveQualificationClient,
      externalQualificationVerifier: effectiveQualificationVerifier,
      qualificationStateStore,
      qualificationRetry: effectiveQualificationRetry,
      launchModeGate,
      supervisorDispatchAuthorization,
      goldenQualificationController,
      providerConfigurationBinding: Object.freeze({
        status: legacyProviderConfigurationBindingMissing
          ? 'autonomous_research_provider_configuration_binding_legacy_missing_read_only'
          : 'autonomous_research_provider_configuration_binding_verified',
        persistedProviderConfigurationHash: providerConfigurationBindingHash,
        currentConfigurationMatched: !legacyProviderConfigurationBindingMissing,
        readOnlyLegacyCompatibility: legacyProviderConfigurationBindingMissing,
        externalProviderActionsAllowed: !legacyProviderConfigurationBindingMissing,
      }),
      runtime: autonomousResearchCampaignRuntimeOptions({
        ...worker,
        resourceGovernor,
        clock: context.services.clock,
        scheduler: context.services.scheduler,
        idGenerator: context.services.idGenerator,
        signal: runtimeSignal,
      }),
    });
    return supervisorReadinessAction.attachReceipts(executionReport);
  } catch (error) {
    const failure = attachAutonomousResearchReadinessFailure({
      error, productionReadiness, releaseAttestorInspection,
      sideEffectLedger: releaseAttestorSideEffectLedger,
    });
    if (supervisorReadinessAction) {
      const evidence = failure.automationReadinessSideEffectInspection || null;
      try {
        supervisorReadinessAction.finalizeFailure({
          evidence,
          blocker: String(failure?.message || failure),
          now: trustedAutonomousResearchReadinessInspectionTime(readinessClock),
        });
      } catch (journalError) {
        failure.supervisorExternalActionJournalFinalizationError = String(
          journalError?.message || journalError,
        );
      }
    }
    throw failure;
  } finally {
    context?.services.persistenceSession.close();
  }
}
