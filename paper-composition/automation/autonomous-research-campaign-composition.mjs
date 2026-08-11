import { composeAutonomousResearchReadiness, attachAutonomousResearchReadinessFailure,
  inspectAutonomousResearchCampaignReleaseAttestor,
  verifyAutonomousResearchSupervisorReadinessAuthorization } from './autonomous-research-readiness-composition.mjs';
import { composeCampaignWorkerExecution } from './campaign-worker-composition.mjs';
import { bootstrapCampaignExecutionContext } from '../bootstrap/campaign-execution-context-bootstrap.mjs';
import { createAutonomousResearchWorkspaceRepository } from '../../paper-adapters/automation/autonomous-research-workspace-repository.mjs';
import { createAutonomousResearchQualificationStateRepository } from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import { createFullResearchQualificationReceiptPointerRepository } from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import { materializeAutonomousResearchWorkspace } from '../../paper-adapters/automation/autonomous-research-workspace-materializer.mjs';
import { createExternalResearchQualificationProcessAdapter,
  inspectExternalResearchQualificationProcessConfiguration } from '../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import { createAutonomousResearchQualificationContextProvider } from './autonomous-research-qualification-context.mjs';
import { queryAutomationReadiness } from './automation-readiness-query.mjs';
import { AUTONOMOUS_RESEARCH_LAUNCH_MODES, evaluateAutonomousResearchLaunchModeGate,
  resolvePersistedAutonomousResearchLaunchMode,
  resolveAutonomousResearchDirectLocalRunBudgetWaiverForCampaign,
  resolveAutonomousResearchProviderPricing } from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import { issueAutonomousResearchSupervisorDispatchAuthorization } from '../../paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs';
import { autonomousResearchCampaignRuntimeOptions, autonomousResearchReadinessInspectionTime, createGoldenCampaignQualificationController, prepareAutonomousResearchSupervisorReadinessAction, trustedAutonomousResearchReadinessInspectionTime } from './autonomous-research-supervisor-external-action-composition.mjs';
import { buildAutonomousResearchCampaignPlan,
  executeAutonomousResearchCampaign } from '../../paper-application/automation/autonomous-research-campaign.mjs';
import {
  campaignWorkerOptions, composeAutonomousResearchQualificationRenewal,
  closeAutonomousResearchResourceBudgets,
  configuredMaximumCost, providerBoundReadinessEnvironment,
  qualificationRetryBoundToExternalCostAuthority, readAutonomousDatasetAuthorityReceipt,
  readCurrentRelease,
  requireExistingProductionPricingEnvelope, requirePersistedAutonomousProviderConfiguration,
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-qualification-composition.mjs';
import {
  composeAutonomousResearchSubmissionServices,
} from './autonomous-research-submission-composition.mjs';
import {
  composeAutonomousSubmissionDispatchContext,
} from './autonomous-submission-runtime-composition.mjs';
export { composeAutonomousResearchQualificationRenewal,
  issueAutonomousResearchSupervisorDispatchAuthorization,
  qualificationRetryBoundToExternalCostAuthority, requireExistingProductionPricingEnvelope,
  requirePersistedAutonomousProviderConfiguration };

export { composeAutonomousResearchMachineIntakeEnqueue } from './autonomous-research-machine-intake-enqueue-composition.mjs';

export async function composeAutonomousResearchCampaignAction({
  action = 'prepare',
  launchMode = null,
  localOnly = false,
  directLocalRunBudgetWaiver = null,
  directLocalRunCliProvenance = null,
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
  qualificationStateMutationCoordinator = null,
  requireExternallyFencedQualificationState = false,
  nativeStoreMutationCoordinator = null,
  requireExternallyFencedNativeStore = false,
  qualificationPublicationMutationCoordinator = null,
  requireExternallyFencedQualificationPublication = false,
  serviceOverrides = {},
  executorOverride = null,
  campaignRunner = undefined,
  requireCampaignAbsentAtLaunch = false,
  productionReadinessInspector = queryAutomationReadiness,
  releaseAttestorSpawnSyncImpl = undefined,
  readinessClock = null,
  supervisorDispatchAuthorization = null,
  supervisorExternalActionJournal = null,
  assertExternalSideEffectReady = null,
  runtimeSignal = null,
  worker = {},
} = {}) {
  if (typeof requireCampaignAbsentAtLaunch !== 'boolean') {
    throw new Error('autonomous_research_require_campaign_absent_at_launch_invalid');
  }
  if (requireCampaignAbsentAtLaunch && action !== 'launch') {
    throw new Error(
      'autonomous_research_require_campaign_absent_at_launch_requires_launch_action',
    );
  }
  const assertCampaignAbsentAtLaunch = (campaign) => {
    if (requireCampaignAbsentAtLaunch && campaign) {
      throw new Error(
        `autonomous_research_campaign_already_exists_at_launch:${campaign.campaignId}`,
      );
    }
  };
  if (localOnly === true
    && launchMode !== AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP) {
    throw new Error('autonomous_research_local_mode_requires_bounded_launch_mode');
  }
  const initialWorkerOptions = campaignWorkerOptions({ ...worker, budgets });
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    options: initialWorkerOptions,
    environment,
  });
  const providerConfigurationHash =
    providerConfiguration.autonomousResearchProviderConfigurationHash;
  const receiptPointerRepository = createFullResearchQualificationReceiptPointerRepository({
    runtimeRoot,
    mutationCoordinator: qualificationPublicationMutationCoordinator,
    offlineProvision: !requireExternallyFencedQualificationPublication,
    requireExternallyFencedMutations: requireExternallyFencedQualificationPublication,
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
  const {
    autonomousSubmissionRequestVerifier,
    autonomousSubmissionDispatchAuthority,
  } = composeAutonomousSubmissionDispatchContext({
    root,
    runtimeRoot,
    clock: serviceOverrides.clock || readinessClock || null,
    environment: readinessEnvironment,
    handoffOnly: true,
  });
  const {
    autonomousSubmissionPortal,
    autonomousVenueComplianceInspector,
    verifyAutonomousSubmissionHumanAuthorization,
  } = composeAutonomousResearchSubmissionServices({
    root,
    environment: readinessEnvironment,
    runtimeRoot,
    clock: serviceOverrides.clock || readinessClock || null,
    autonomousSubmissionRequestVerifier,
  });
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
  const requestedCampaignId = campaignId
    || (paperId ? `autonomous-research:${paperId}` : null);
  const id = action === 'prepare' ? null : requestedCampaignId;
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
        execute: !readOnly, readOnly, allowMissingReadOnlyStore: readOnly, serviceOverrides,
        environment: readinessEnvironment,
        nativeStoreMutationCoordinator,
        requireExternallyFencedNativeStore,
        requireExternallyFencedSubmissionHandoff: productionMutation,
        autonomousSubmissionDispatchAuthority,
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
  const assertCampaignExternalSideEffectReady = async (externalAction) => {
    if (!assertExternalSideEffectReady) return;
    await assertExternalSideEffectReady({ action: externalAction });
    assertExternalSideEffectReady.assertCurrent?.({ action: externalAction });
  };
  try {
    existing = campaignStore?.getCampaign(id) || null;
    assertCampaignAbsentAtLaunch(existing);
    if (existing) {
      resolvePersistedAutonomousResearchLaunchMode({
        campaign: existing,
        requestedLaunchMode: launchMode,
        requestedLocalOnly: localOnly,
      });
    }
    const effectiveBudgetWaiver =
      resolveAutonomousResearchDirectLocalRunBudgetWaiverForCampaign({
        existingCampaign: existing,
        requestedWaiver: directLocalRunBudgetWaiver,
      });
    const effectiveDirectLocalRunCliProvenance = existing
      ?.spec?.autonomousResearchPreparation?.directLocalRunCliProvenance
      || directLocalRunCliProvenance;
    supervisorReadinessAction = await prepareAutonomousResearchSupervisorReadinessAction({
      dispatchMutation, productionMutation, supervisorDispatchAuthorization,
      campaign: existing, campaignId: id, launchMode, action, providerConfigurationHash,
      supervisorExternalActionJournal,
      now: new Date(productionReadinessObservedAt
        || trustedAutonomousResearchReadinessInspectionTime(readinessClock)),
    });
    const supervisorProviderCanaryAuthorized = supervisorReadinessAction.authorized;
    if (productionMutation) {
      let result = supervisorReadinessAction.recovered
        ? supervisorReadinessAction.recoveredResult.actionResult : null;
      if (!supervisorReadinessAction.recovered) {
        await assertCampaignExternalSideEffectReady('production_readiness_inspection');
        await assertExternalSideEffectReady?.markStarted?.({
          action: 'production_readiness_inspection',
        });
        await supervisorReadinessAction.markStarted();
        result = await productionReadinessInspector({
          root,
          runtimeRoot,
          environment: readinessEnvironment,
          liveProviderCanaryRequested: !supervisorProviderCanaryAuthorized,
          requireFullResearch: true,
          now: new Date(productionReadinessObservedAt.getTime()),
        });
      }
      productionReadiness = result?.report || result?.readiness || result || null;
      const sideEffectInspection = productionReadiness?.readinessSideEffectInspection || null;
      if (!supervisorReadinessAction.recovered) {
        supervisorReadinessAction.finalizeSuccess({
          evidence: sideEffectInspection,
          now: new Date(productionReadinessObservedAt.getTime()),
        });
      }
    }
    const gateBudgets = existing
      ? { ...(existing.spec?.budgets || {}), ...budgets }
      : budgets;
    let launchModeGate = evaluateAutonomousResearchLaunchModeGate({
      launchMode,
      action,
      budgets: gateBudgets,
      localOnly,
      directLocalRunBudgetWaiver: effectiveBudgetWaiver,
      directLocalRunCliProvenance: effectiveDirectLocalRunCliProvenance,
      autonomousResearchPreparation:
        existing?.spec?.autonomousResearchPreparation || null,
      directLocalRunPreparationPending: !existing && Boolean(effectiveBudgetWaiver),
      campaignId: existing?.campaignId || requestedCampaignId,
      paperId: existing?.paperId || paperId,
      providerPricingInspection,
      fullResearchReadiness: productionReadiness,
    });
    if (launchModeGate.status !== 'autonomous_research_launch_mode_ready') {
      throw new Error(
        `autonomous_research_launch_mode_blocked:${launchModeGate.blockers.join(',')}`,
      );
    }
    let effectiveBudgets = launchModeGate.effectiveBudgets;
    let workerOptions = campaignWorkerOptions({ ...worker, budgets: effectiveBudgets });
    const datasetAuthorityReceipt = readAutonomousDatasetAuthorityReceipt({
    datasetMounts,
    runtimeRoot,
  });
    const injectedQualificationServices = localOnly !== true && Boolean(
      externalQualificationClient || externalQualificationVerifier,
    );
    if (localOnly !== true
      && Boolean(externalQualificationClient) !== Boolean(externalQualificationVerifier)) {
      throw new Error('autonomous_research_external_qualification_services_incomplete');
    }
    const qualificationConfigurationRequested = localOnly !== true && Boolean(
      externalQualificationConfigPath
      || environment.HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG,
  );
    if (injectedQualificationServices && qualificationConfigurationRequested) {
      throw new Error('autonomous_research_external_qualification_service_source_conflict');
  }
    const activeReleaseAttestorVerification = dispatchMutation
      && supervisorProviderCanaryAuthorized && !supervisorReadinessAction.recovered;
    if (activeReleaseAttestorVerification) {
      await assertCampaignExternalSideEffectReady(
        'release_attestor_active_verification',
      );
      await assertExternalSideEffectReady?.markStarted?.({
        action: 'release_attestor_active_verification',
      });
      await supervisorReadinessAction.markStarted();
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
      activeVerification: activeReleaseAttestorVerification,
      actionClock: readinessClock || serviceOverrides.clock
        || { now: () => new Date() },
      spawnSyncImpl: releaseAttestorSpawnSyncImpl,
    }));
    if (supervisorReadinessAction.recovered
      && supervisorReadinessAction.actionKind === 'golden-release-attestor') {
      releaseAttestorInspection = supervisorReadinessAction.recoveredResult
        .actionResult?.releaseAttestorInspection || null;
    }
    if (supervisorReadinessAction.actionKind === 'golden-release-attestor') {
      const sideEffectInspection = releaseAttestorSideEffectLedger.inspection({
        releaseAttestorInspection,
      });
      if (!supervisorReadinessAction.recovered) {
        supervisorReadinessAction.finalizeSuccess({
          evidence: sideEffectInspection,
          now: autonomousResearchReadinessInspectionTime(createdAt),
        });
      }
    }
    const externalQualificationConfigurationInspection = localOnly === true
      || injectedQualificationServices
      ? null
      : inspectExternalResearchQualificationProcessConfiguration({
      configPath: externalQualificationConfigPath,
      environment,
    });
    if (action === 'prepare') {
      await assertCampaignExternalSideEffectReady(
        'campaign_readiness_composition',
      );
      await assertExternalSideEffectReady?.markStarted?.({
        action: 'campaign_readiness_composition_preflight',
      });
      return composeAutonomousResearchReadiness({
      paperId, campaignId: requestedCampaignId,
      objective, protocolFamily, revisionRounds, refereeCount, humanSubjects, privateData,
      datasetMounts,
      datasetAuthorityReceipt,
      researchContentWorkspace: root,
      runtimeRoot,
      createdAt, environment,
      providerConfiguration,
      expectedProviderConfigurationHash: providerConfigurationHash,
      releaseAttestorInspection,
      externalQualificationConfigurationInspection,
      externalQualificationClient: localOnly === true ? null : externalQualificationClient,
      externalQualificationVerifier: localOnly === true ? null : externalQualificationVerifier,
      localOnly,
      directLocalRunCliProvenance: effectiveDirectLocalRunCliProvenance,
      launchModeGate,
      providerPricingInspection,
      autonomousSubmissionRequestVerifier,
      autonomousSubmissionPortal,
      ...(preflightAuthor ? { preflightAuthor } : {}),
      ...(preflightReviewer ? { preflightReviewer } : {}),
      ...(preflightEmpiricalRuntime ? { preflightEmpiricalRuntime } : {}),
      assertExternalSideEffectReady,
      });
    }
    if (!context) {
      campaignExecutionContext = bootstrapCampaignExecutionContext({
        root, runtimeRoot, mode: 'autonomous-research-campaign',
        execute: !readOnly, readOnly, serviceOverrides,
        nativeStoreMutationCoordinator,
        requireExternallyFencedNativeStore,
        autonomousSubmissionDispatchAuthority,
      });
      context = campaignExecutionContext.context;
      campaignStore = context.services.campaignStore;
      existing = campaignStore.getCampaign(id);
      assertCampaignAbsentAtLaunch(existing);
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
        requestedLocalOnly: localOnly,
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
    const configuredQualification = localOnly !== true
      && !legacyProviderConfigurationBindingMissing
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
            onProgress: assertExternalSideEffectReady
              ? ({ stage = 'qualification_context' } = {}) => (
                assertExternalSideEffectReady({
                  action: `qualification_context:${stage}`,
                })
              ) : null,
            onSynchronousProgress: assertExternalSideEffectReady?.assertCurrent
              ? ({ stage = 'qualification_context_synchronous' } = {}) => (
                assertExternalSideEffectReady.assertCurrent({
                  action: `qualification_context:${stage}`,
                })
              ) : null,
          }),
      }) : null;
    const effectiveQualificationClient = localOnly === true
      ? null : legacyProviderConfigurationBindingMissing
      ? null
      : externalQualificationClient || configuredQualification?.client || null;
    const effectiveQualificationVerifier = localOnly === true
      ? null : legacyProviderConfigurationBindingMissing
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
      await assertCampaignExternalSideEffectReady(
        'campaign_readiness_composition',
      );
      await assertExternalSideEffectReady?.markStarted?.({
        action: 'campaign_readiness_composition_preflight',
      });
      readinessReport = await composeAutonomousResearchReadiness({
        paperId, campaignId: requestedCampaignId,
        objective, protocolFamily, revisionRounds, refereeCount, humanSubjects, privateData,
        datasetMounts,
        datasetAuthorityReceipt,
        researchContentWorkspace: root,
        runtimeRoot,
        createdAt, environment,
        providerConfiguration,
        expectedProviderConfigurationHash: providerConfigurationHash,
        releaseAttestorInspection,
        externalQualificationConfigurationInspection:
          configuredQualification?.inspection || externalQualificationConfigurationInspection,
        externalQualificationClient,
        externalQualificationVerifier,
        localOnly,
        directLocalRunCliProvenance: effectiveDirectLocalRunCliProvenance,
        launchModeGate,
        providerPricingInspection,
        autonomousSubmissionRequestVerifier,
        autonomousSubmissionPortal,
        ...(preflightAuthor ? { preflightAuthor } : {}),
        ...(preflightReviewer ? { preflightReviewer } : {}),
        ...(preflightEmpiricalRuntime ? { preflightEmpiricalRuntime } : {}),
        assertExternalSideEffectReady,
      });
      const resourceBudgetClosure = closeAutonomousResearchResourceBudgets({
        campaignId: id,
        loopPreparation: readinessReport.loopPreparation,
        datasetMounts,
        requestedBudgets: budgets,
        launchMode,
        action,
        localOnly,
        directLocalRunBudgetWaiver: effectiveBudgetWaiver,
        directLocalRunCliProvenance: effectiveDirectLocalRunCliProvenance,
        autonomousResearchPreparation: readinessReport.loopPreparation,
        launchModeGate,
        providerPricingInspection,
        fullResearchReadiness: productionReadiness,
      });
      launchModeGate = resourceBudgetClosure.launchModeGate;
      effectiveBudgets = resourceBudgetClosure.effectiveBudgets;
      workerOptions = campaignWorkerOptions({ ...worker, budgets: effectiveBudgets });
      const preparation = readinessReport.loopPreparation;
      const repository = createAutonomousResearchWorkspaceRepository({
        runtimeRoot,
        paperId: preparation.proposal.paperId,
      });
      qualificationStateStore = createAutonomousResearchQualificationStateRepository({
        runtimeRoot,
        paperId: preparation.proposal.paperId,
        offlineProvision: !requireExternallyFencedQualificationState,
        mutationCoordinator: qualificationStateMutationCoordinator,
        requireExternallyFencedMutations: requireExternallyFencedQualificationState,
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
        localOnly,
        directLocalRunBudgetWaiver: effectiveBudgetWaiver,
      });
    }
    if (!qualificationStateStore && existing && !legacyProviderConfigurationBindingMissing) {
      qualificationStateStore = createAutonomousResearchQualificationStateRepository({
        runtimeRoot,
        paperId: existing.paperId,
        create: action !== 'status',
        offlineProvision: action !== 'status'
          && !requireExternallyFencedQualificationState,
        mutationCoordinator: qualificationStateMutationCoordinator,
        requireExternallyFencedMutations: requireExternallyFencedQualificationState,
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
        assertExternalSideEffectReady,
        executionRequested: true,
      });
      executor = composed.nodeExecutor;
    }
    const resourceGovernor = readOnly ? null : context.services.resourceGovernorFactory({
      agent: Number(worker.agentSlots || 4),
      cpu: Number(worker.cpuSlots || 4),
      gpu: Number(worker.gpuSlots || 1),
      memoryMiB: Number(worker.memoryMiB || 8192),
    });
    const goldenQualificationController = localOnly !== true && launchMode
        === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP
      && effectiveQualificationVerifier?.kind
        === 'IndependentExternalResearchQualificationVerifier'
      && typeof effectiveQualificationVerifier.verifyLocally === 'function'
      ? createGoldenCampaignQualificationController({
        localQualificationVerifier: effectiveQualificationVerifier,
        receiptPointerRepository,
        clock: context.services.clock,
      }) : null;
    if (requireCampaignAbsentAtLaunch) {
      assertCampaignAbsentAtLaunch(campaignStore.getCampaign(id));
    }
    const executionReport = await executeAutonomousResearchCampaign({
      action,
      localOnly,
      directLocalRunBudgetWaiver: effectiveBudgetWaiver,
      readinessReport,
      campaignId: id,
      datasetMounts,
      budgets: existing ? budgets : effectiveBudgets,
      campaignStore,
      requireCampaignAbsentAtLaunch,
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
      autonomousSubmissionPortal,
      autonomousSubmissionOutbox: context.services.autonomousSubmissionOutbox,
      autonomousVenueComplianceInspector,
      autonomousSubmissionRequestVerifier,
      verifyAutonomousSubmissionHumanAuthorization,
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
        assertExternalSideEffectReady,
        packageLifecycleAuthority: context.services.packageLifecycleAuthority,
      }),
    });
    return supervisorReadinessAction.attachReceipts(executionReport);
  } catch (error) {
    const infrastructureFailure = error?.stateRecoverabilityFatal === true
      || error?.stateRecoverabilityDeferred === true
      || error?.authorityEvidenceRenewalFatal === true
      || error?.authorityEvidenceRenewalDeferred === true
      || error?.residentReactivationRequired === true;
    if (infrastructureFailure) {
      try {
        supervisorReadinessAction?.cancelInfrastructureDeferred({ error });
      } catch (cancelError) {
        const fatal = new Error(
          'autonomous_research_supervisor_external_action_infrastructure_cancel_failed',
          { cause: cancelError },
        );
        fatal.stateRecoverabilityFatal = true;
        fatal.originalInfrastructureControlError = error;
        throw fatal;
      }
      throw error;
    }
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
