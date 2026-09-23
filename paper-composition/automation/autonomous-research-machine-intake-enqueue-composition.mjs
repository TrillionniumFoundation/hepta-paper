import {
  composeAutonomousResearchReadiness,
  createAutonomousResearchAdmissionPreflightSandbox,
  createAutonomousResearchMachineIntakeActionFence,
  inspectAutonomousResearchProductionAdmissionReadiness,
} from './autonomous-research-readiness-composition.mjs';
import { bootstrapCampaignExecutionContext } from '../bootstrap/campaign-execution-context-bootstrap.mjs';
import { createAutonomousResearchWorkspaceRepository } from '../../paper-adapters/automation/autonomous-research-workspace-repository.mjs';
import { createFullResearchQualificationReceiptPointerRepository } from '../../paper-adapters/automation/full-research-qualification-receipt-pointer-repository.mjs';
import { materializeAutonomousResearchWorkspace } from '../../paper-adapters/automation/autonomous-research-workspace-materializer.mjs';
import { inspectResearchExecutionReleaseAttestorConfiguration } from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import { inspectExternalResearchQualificationProcessConfiguration } from '../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import {
  AUTONOMOUS_RESEARCH_LAUNCH_MODES,
  evaluateAutonomousResearchLaunchModeGate,
  resolveAutonomousResearchProviderPricing,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import { verifyAutonomousResearchMachineIntake } from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import { verifyAutonomousResearchMachineIntakeAdmission } from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import { enqueuePreparedAutonomousResearchCampaign } from '../../paper-application/automation/autonomous-research-campaign.mjs';
import {
  campaignWorkerOptions,
  configuredMaximumCost,
  providerBoundReadinessEnvironment,
  readAutonomousDatasetAuthorityReceipt,
  requireAutonomousResearchProviderConfiguration,
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-qualification-composition.mjs';
import {
  composeAutonomousResearchSubmissionServices,
} from './autonomous-research-submission-composition.mjs';
import {
  composePinnedAutonomousSubmissionRequestVerifier,
} from './autonomous-submission-request-verifier-composition.mjs';
import {
  closeAutonomousResearchResourceBudgets,
} from './autonomous-research-resource-budget-composition.mjs';
import {
  buildAutonomousResearchGpuScientificExecutionPlan,
} from './autonomous-research-gpu-scientific-plan.mjs';

export async function composeAutonomousResearchMachineIntakeEnqueue({
  intake,
  machineIntakeAdmission,
  root,
  runtimeRoot,
  environment = process.env,
  externalQualificationConfigPath = null,
  serviceOverrides = {},
  nativeStoreMutationCoordinator = null,
  requireExternallyFencedNativeStore = false,
  qualificationPublicationMutationCoordinator = null,
  requireExternallyFencedQualificationPublication = false,
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
    if (!Number.isFinite(value.getTime())) throw new Error('autonomous_research_machine_intake_clock_invalid');
    return value;
  };
  const observedAt = currentTime();
  if (!verifyAutonomousResearchMachineIntake(intake)
    || !verifyAutonomousResearchMachineIntakeAdmission(machineIntakeAdmission, { intake })) {
    throw new Error('autonomous_research_machine_intake_invalid');
  }
  if (!Number.isFinite(observedAt.getTime())) throw new Error('autonomous_research_machine_intake_clock_invalid');
  if (runtimeSignal?.aborted) throw new Error(String(runtimeSignal.reason || 'autonomous_research_machine_intake_aborted'));
  const admissionCreatedAt = new Date(intake.admissionCreatedAt);
  if (!Number.isFinite(admissionCreatedAt.getTime())) throw new Error('autonomous_research_machine_intake_admission_time_invalid');
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
  const initialWorkerOptions = campaignWorkerOptions({ ...worker, budgets: intake.budgets });
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    options: initialWorkerOptions,
    environment,
  });
  requireAutonomousResearchProviderConfiguration(providerConfiguration, {
    expectedHash: intake.providerConfigurationHash,
  });
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
  const autonomousSubmissionRequestVerifier =
    composePinnedAutonomousSubmissionRequestVerifier({
      root,
      runtimeRoot,
      clock,
      environment: readinessEnvironment,
    });
  const { autonomousSubmissionPortal } = composeAutonomousResearchSubmissionServices({
    environment: readinessEnvironment,
    runtimeRoot,
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
  const releaseAttestorInspection = inspectResearchExecutionReleaseAttestorConfiguration({
    runtimeRoot,
    configPath: readinessEnvironment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG || null,
    now: currentTime(),
    environment: readinessEnvironment,
    activeVerification: false,
  });
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
    researchContentWorkspace: root,
    runtimeRoot,
    environment: readinessEnvironment,
    providerConfiguration,
    expectedProviderConfigurationHash: intake.providerConfigurationHash,
    releaseAttestorInspection,
    externalQualificationConfigurationInspection,
    launchMode: intake.launchMode,
    providerPricingInspection,
    autonomousSubmissionRequestVerifier,
    autonomousSubmissionPortal,
    spawnSyncImpl: admissionPreflightSandbox.spawnSyncImpl,
    ...(preflightAuthor ? { preflightAuthor } : {}),
    ...(preflightReviewer ? { preflightReviewer } : {}),
    ...(preflightEmpiricalRuntime ? { preflightEmpiricalRuntime } : {}),
  });
  const productionReadiness = intake.launchMode
    === AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN
    ? inspectAutonomousResearchProductionAdmissionReadiness({
      runtimeRoot,
      environment: readinessEnvironment,
      releaseAttestorInspection,
      capabilityScopeManifest: readinessReport.loopPreparation.capabilityScopeManifest,
      researchAgendaProducerReceipt:
        readinessReport.loopPreparation.researchAgendaProducerReceipt,
      now: currentTime(),
    }) : null;
  let launchModeGate = evaluateAutonomousResearchLaunchModeGate({
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
  const resourceBudgetClosure = closeAutonomousResearchResourceBudgets({
    campaignId: intake.campaignId,
    loopPreparation: readinessReport.loopPreparation,
    datasetMounts: intake.datasetMounts,
    requestedBudgets: intake.budgets,
    launchMode: intake.launchMode,
    action: 'launch',
    launchModeGate,
    providerPricingInspection,
    fullResearchReadiness: productionReadiness,
    admissionOnly: true,
  });
  launchModeGate = resourceBudgetClosure.launchModeGate;
  fence({ renew: true, action: 'before_workspace_materialization' });
  const execution = bootstrapCampaignExecutionContext({
    root,
    runtimeRoot,
    mode: 'autonomous-research-machine-intake-enqueue',
    execute: true,
    serviceOverrides,
    nativeStoreMutationCoordinator,
    requireExternallyFencedNativeStore,
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
    const gpuScientificExecutionPlan =
      buildAutonomousResearchGpuScientificExecutionPlan({
        campaignId: intake.campaignId,
        loopPreparation: preparation,
        budgets: launchModeGate.effectiveBudgets,
        productionReadiness,
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
      gpuScientificExecutionPlan,
      campaignStore: context.services.campaignStore,
      preparedMaterialization: materialization,
    });
    fence({ action: 'after_campaign_enqueue_commit' });
    return enqueued;
  } finally {
    context.services.persistenceSession.close();
  }
}
