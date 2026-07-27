import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildPaperCampaignPlan } from '../../paper-domain/automation/campaign-plan.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { analysisProtocolMatchesEmpiricalClaimUniverse } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import { verifyAutonomousEmpiricalClaimLineage } from '../../paper-domain/automation/autonomous-empirical-claim-lineage-contract.mjs';
import {
  evaluateAutonomousCampaignTopology,
} from '../../paper-domain/automation/autonomous-research-readiness-policy.mjs';
import { runPaperCampaign } from './campaign-engine.mjs';
import { presentCampaignStatus, summarizeRun } from './campaign-query-presenter.mjs';
import {
  verifyAutonomousEmpiricalExecutionProfileSelection,
} from '../../paper-domain/automation/autonomous-empirical-execution-profile-policy.mjs';
import {
  autonomousResearchCampaignDispatchAuthorizationTime,
  requireAutonomousResearchCampaignDispatchAuthorization,
} from './autonomous-research-campaign-dispatch.mjs';
import {
  evaluateAutonomousResearchCampaignQualification,
  requestAutonomousResearchCampaignQualification,
} from './autonomous-research-campaign-qualification.mjs';
import {
  resolveAutonomousResearchCampaignSubmission,
} from './autonomous-research-campaign-submission.mjs';
import {
  assertAutonomousResearchResourceBudgetClosure,
} from '../../paper-domain/automation/autonomous-research-resource-budget-policy.mjs';

const SETTLED = new Set(['completed', 'failed', 'cancelled']);
const ADMISSION_PREFLIGHT_INSPECTION_KEYS = Object.freeze([
  'autonomousResearchAdmissionPreflightExecutionInspectionHash',
  'externalActionPerformed',
  'kind',
  'localDaemonActionPerformed',
  'localDockerDaemonProbeCount',
  'localProcessActionPerformed',
  'networkActionPerformed',
  'processCount',
  'sandbox',
  'version',
].sort());

function hasExplicitBudgetConfiguration(budgets) {
  return budgets && typeof budgets === 'object' && !Array.isArray(budgets)
    && Object.values(budgets).some((value) => value !== undefined);
}

function loopPreparationFrom(report) {
  return report?.kind === 'AutonomousResearchReadinessCompositionReport'
    ? report.loopPreparation
    : report;
}

function requireCampaignStore(campaignStore) {
  for (const method of ['createCampaign', 'getCampaign', 'listNodes', 'resumeCampaign']) {
    if (typeof campaignStore?.[method] !== 'function') {
      throw new Error('autonomous_research_campaign_store_required');
    }
  }
  return campaignStore;
}

export function requireAutonomousResearchAdmissionPreflightExecutionInspection(inspection) {
  const {
    autonomousResearchAdmissionPreflightExecutionInspectionHash: claimedHash,
    ...payload
  } = inspection || {};
  const processCount = Number(inspection?.processCount);
  const localDockerDaemonProbeCount = Number(inspection?.localDockerDaemonProbeCount);
  if (!inspection || Object.getPrototypeOf(inspection) !== Object.prototype
    || JSON.stringify(Object.keys(inspection).sort())
      !== JSON.stringify(ADMISSION_PREFLIGHT_INSPECTION_KEYS)
    || inspection.version !== 1
    || inspection.kind !== 'AutonomousResearchAdmissionPreflightExecutionInspection'
    || inspection.sandbox !== 'bubblewrap-unshare-net-read-only-root-v1'
    || !Number.isSafeInteger(inspection.processCount) || processCount !== 8
    || !Number.isSafeInteger(inspection.localDockerDaemonProbeCount)
    || localDockerDaemonProbeCount !== 2
    || inspection.localProcessActionPerformed !== true
    || inspection.localDaemonActionPerformed !== true
    || inspection.networkActionPerformed !== false
    || inspection.externalActionPerformed !== false
    || hashRecord(
      'AutonomousResearchAdmissionPreflightExecutionInspection',
      payload,
    ) !== claimedHash) {
    throw new Error('autonomous_research_admission_preflight_execution_inspection_invalid');
  }
  return inspection;
}

export function buildAutonomousResearchCampaignPlan({
  loopPreparation,
  materialization,
  datasetMounts = [],
  campaignId = null,
  budgets = {},
  machineIntake = null,
  machineIntakeAdmission = null,
} = {}) {
  const proposal = loopPreparation?.proposal;
  const empiricalProfileSelection = loopPreparation?.empiricalExecutionProfileSelection;
  if (loopPreparation?.autonomousExecutionLaunchReady !== true
    || materialization?.status !== 'autonomous_research_workspace_materialized') {
    throw new Error('autonomous_research_campaign_launch_not_ready');
  }
  if (!verifyAutonomousEmpiricalExecutionProfileSelection(empiricalProfileSelection, {
    protocolFamily: proposal?.protocolFamily,
    requireReady: true,
    runtimeCapabilityInspection: loopPreparation?.empiricalRuntimeCapabilityInspection,
    requireRuntimeCapabilityInspection: true,
    runtimeReproducibilityInspection:
      loopPreparation?.runtimeImageReproducibilityInspection,
    requireRegisteredRuntime: loopPreparation?.launchMode === 'production-run',
    observedAt: loopPreparation?.createdAt,
  }) || loopPreparation?.topologyTemplate?.empiricalExecutionProfileSelectionHash
    !== empiricalProfileSelection.autonomousEmpiricalExecutionProfileSelectionHash
    || JSON.stringify(loopPreparation?.topologyTemplate?.empiricalExecutionProfile)
      !== JSON.stringify(empiricalProfileSelection.executionProfile)) {
    throw new Error('autonomous_research_empirical_execution_profile_invalid');
  }
  if (!Array.isArray(datasetMounts) || datasetMounts.length !== 1
    || datasetMounts[0]?.benchmarkFamily !== proposal?.protocolFamily
    || loopPreparation?.datasetLaunchInspection?.status
      !== 'autonomous_research_dataset_launch_ready'
    || loopPreparation.datasetLaunchInspection.datasetManifestHash
      !== datasetMounts[0]?.manifestHash
    || loopPreparation.datasetLaunchInspection.operatorDatasetAuthorityDocumentHash
      !== datasetMounts[0]?.operatorDatasetAuthorityDocumentHash) {
    throw new Error('autonomous_research_academic_dataset_authority_required');
  }
  const {
    autonomousResearchWorkspaceMaterializationReceiptHash: materializationHash,
    ...materializationPayload
  } = materialization;
  const templateSelector = buildCampaignBenchmarkSelector({
    benchmarkId: datasetMounts[0].name,
    venueTarget: loopPreparation?.venueProfileSelection?.venueId || null,
    datasetMounts,
  });
  const analysisProtocolTemplate = Object.freeze({
    ...templateSelector.experimentDesign.analysisProtocol,
    analysisProtocolHash: templateSelector.experimentDesign.analysisProtocolHash,
  });
  const expectedMaterializationVersion = loopPreparation?.venueRequirementIr ? 3 : 2;
  if (materialization.version !== expectedMaterializationVersion
    || hashRecord('AutonomousResearchWorkspaceMaterializationReceipt', materializationPayload)
      !== materializationHash
    || materialization.analysisProtocolTemplateHash !== analysisProtocolTemplate.analysisProtocolHash
    || materialization.empiricalExecutionProfileSelectionHash
      !== empiricalProfileSelection.autonomousEmpiricalExecutionProfileSelectionHash
    || materialization.empiricalRuntimeCapabilityInspectionHash
      !== empiricalProfileSelection.runtimeCapabilityInspectionHash
    || !verifyAutonomousEmpiricalClaimLineage({
      lineage: materialization.empiricalClaimLineage,
      proposal,
      seedBundle: loopPreparation.seedBundle,
      analysisProtocolTemplate,
      empiricalClaimUniverse: materialization.empiricalClaimUniverse,
    })) {
    throw new Error('autonomous_research_empirical_claim_lineage_invalid');
  }
  const plan = buildPaperCampaignPlan({
    paperId: proposal.paperId,
    sourceWorkspace: materialization.sourceWorkspace,
    campaignId: campaignId || `autonomous-research:${proposal.paperId}`,
    mode: 'full-campaign',
    maxRounds: loopPreparation.topologyTemplate.revisionRounds,
    refereeCount: loopPreparation.topologyTemplate.refereeCount,
    minimumRevisionRounds: 1,
    languages: ['lean', empiricalProfileSelection.executionProfile.language, 'latex'],
    datasetMounts,
    benchmarkId: datasetMounts[0].name,
    empiricalClaimUniverse: materialization.empiricalClaimUniverse,
    applyManuscript: true,
    paperQualityProfiles: ['formal_theorem_or_proof', 'empirical_or_experiment'],
    scientificClaimAuthority: loopPreparation.seedBinding,
    autonomousResearchPreparation: loopPreparation,
    autonomousResearchMachineIntake: machineIntake,
    autonomousResearchMachineIntakeAdmission: machineIntakeAdmission,
    budgets,
  });
  assertAutonomousResearchResourceBudgetClosure({
    campaignId: plan.campaignId, loopPreparation, datasetMounts, budgets: plan.budgets,
  });
  const topology = evaluateAutonomousCampaignTopology({ nodes: plan.nodes });
  if (topology.status !== 'autonomous_research_campaign_topology_ready') {
    throw new Error(`autonomous_research_campaign_topology_invalid:${topology.blockers.join(',')}`);
  }
  if (plan.autonomousEmpiricalExecutionProfileSelectionHash
      !== empiricalProfileSelection.autonomousEmpiricalExecutionProfileSelectionHash
    || plan.languages.filter((language) => !['lean', 'latex'].includes(language)).length !== 1
    || plan.languages.filter((language) => !['lean', 'latex'].includes(language))[0]
      !== empiricalProfileSelection.executionProfile.language) {
    throw new Error('autonomous_research_campaign_profile_binding_invalid');
  }
  const boundAnalysisProtocol = Object.freeze({
    ...plan.benchmarkSelector?.analysisProtocol,
    analysisProtocolHash: plan.benchmarkSelector?.analysisProtocolHash,
  });
  if (boundAnalysisProtocol.version !== 2
    || !analysisProtocolMatchesEmpiricalClaimUniverse(
      boundAnalysisProtocol,
      materialization.empiricalClaimUniverse,
    )) {
    throw new Error('autonomous_research_empirical_protocol_lineage_invalid');
  }
  return plan;
}

export function enqueuePreparedAutonomousResearchCampaign({
  readinessReport,
  campaignId,
  datasetMounts = [],
  budgets = {},
  campaignStore,
  preparedMaterialization,
  machineIntake = null,
  machineIntakeAdmission = null,
  admissionPreflightExecutionInspection = null,
} = {}) {
  const store = requireCampaignStore(campaignStore);
  const preparation = loopPreparationFrom(readinessReport);
  const id = campaignId || (preparation?.proposal?.paperId
    ? `autonomous-research:${preparation.proposal.paperId}` : null);
  if (!id || preparation?.autonomousExecutionLaunchReady !== true
    || !preparedMaterialization) {
    throw new Error('autonomous_research_machine_intake_enqueue_not_ready');
  }
  const preflightInspection = machineIntake
    ? requireAutonomousResearchAdmissionPreflightExecutionInspection(
      admissionPreflightExecutionInspection,
    )
    : null;
  const plan = buildAutonomousResearchCampaignPlan({
    loopPreparation: preparation,
    materialization: preparedMaterialization,
    datasetMounts,
    campaignId: id,
    budgets,
    machineIntake,
    machineIntakeAdmission,
  });
  if (plan?.campaignId !== id
    || plan?.scientificClaimAuthority?.autonomousResearchSeedBindingHash
      !== preparation.seedBinding.autonomousResearchSeedBindingHash) {
    throw new Error('autonomous_research_prepared_campaign_plan_invalid');
  }
  const existing = store.getCampaign(id);
  if (existing && (existing.spec?.campaignPlanHash !== plan.campaignPlanHash
    || existing.spec?.autonomousResearchMachineIntakeHash
      !== machineIntake?.intakeHash
    || existing.spec?.autonomousResearchMachineIntakeAdmissionHash
      !== machineIntakeAdmission?.autonomousResearchMachineIntakeAdmissionHash
    || existing.spec?.autonomousResearchPreparation
      ?.autonomousResearchLoopPreparationReportHash
        !== preparation.autonomousResearchLoopPreparationReportHash)) {
    throw new Error('autonomous_research_machine_intake_campaign_identity_conflict');
  }
  const campaign = existing || store.createCampaign(plan);
  if (machineIntake && (campaign.status !== 'paused'
    || campaign.spec?.executionAdmission?.status
      !== 'autonomous_research_campaign_admitted_not_authorized'
    || campaign.spec?.executionAdmission?.initialCampaignStatus !== 'paused'
    || campaign.spec?.executionAdmission?.supervisorDispatchAuthorizationRequired !== true)) {
    throw new Error('autonomous_research_machine_intake_execution_admission_not_persisted');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchCampaignEnqueueReceipt',
    status: existing
      ? 'autonomous_research_campaign_already_enqueued'
      : 'autonomous_research_campaign_enqueued',
    campaignId: id,
    paperId: campaign.paperId,
    campaignPlanHash: plan.campaignPlanHash,
    autonomousResearchMachineIntakeHash: machineIntake?.intakeHash || null,
    autonomousResearchMachineIntakeAdmission: machineIntakeAdmission,
    autonomousResearchMachineIntakeAdmissionHash:
      machineIntakeAdmission?.autonomousResearchMachineIntakeAdmissionHash || null,
    autonomousResearchLoopPreparationReportHash:
      preparation.autonomousResearchLoopPreparationReportHash,
    autonomousResearchCampaignExecutionAdmissionHash:
      campaign.spec?.executionAdmission
        ?.autonomousResearchCampaignExecutionAdmissionHash || null,
    admissionPreflightExecutionInspection: preflightInspection,
    admissionOnly: Boolean(machineIntake),
    executionAuthorized: false,
    initialCampaignStatus: machineIntake ? 'paused' : campaign.status,
    created: !existing,
    executionStarted: false,
    externalActionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    campaign,
    autonomousResearchCampaignEnqueueReceiptHash: hashRecord(
      'AutonomousResearchCampaignEnqueueReceipt',
      payload,
    ),
  });
}

async function executionReport({
  action,
  campaignStore,
  campaignId,
  executionResult = null,
  campaignReleaseAuthorityReader = null,
  externalQualificationClient = null,
  externalQualificationVerifier = null,
  qualificationStateStore = null,
  qualificationRetry = {},
  providerConfigurationBinding = null,
  launchModeGate = null,
  goldenQualificationController = null,
  autonomousSubmissionPortal = null,
  autonomousSubmissionOutbox = null,
  autonomousVenueComplianceInspector = null,
  autonomousSubmissionRequestVerifier = null,
  runtime = {},
} = {}) {
  const campaign = campaignStore.getCampaign(campaignId);
  const nodes = campaignStore.listNodes(campaignId);
  const preparation = campaign?.spec?.autonomousResearchPreparation || null;
  let campaignReleaseAuthority = null;
  if (campaign?.status === 'completed' && typeof campaignReleaseAuthorityReader === 'function') {
    campaignReleaseAuthority = await campaignReleaseAuthorityReader({ campaignId, paperId: campaign.paperId });
  }
  const qualificationFenceProgress = runtime?.assertExternalSideEffectReady
    ? async ({ stage = 'qualification_recovery' } = {}) => {
      await qualificationRetry?.onProgress?.({ stage });
      await runtime.assertExternalSideEffectReady({
        action: `qualification:${stage}`,
      });
    } : qualificationRetry?.onProgress || null;
  const qualificationSynchronousFence = runtime?.assertExternalSideEffectReady
    ?.assertCurrent
    ? ({ stage = 'qualification_synchronous_operation' } = {}) => {
      qualificationRetry?.onSynchronousProgress?.({ stage });
      return runtime.assertExternalSideEffectReady.assertCurrent({
        action: `qualification:${stage}`,
      });
    } : qualificationRetry?.onSynchronousProgress || null;
  const externalQualification = preparation ? await requestAutonomousResearchCampaignQualification({
    externalQualificationClient,
    externalQualificationVerifier,
    campaignReleaseAuthority,
    preparation,
    qualificationStateStore,
    allowRequest: action === 'launch' || action === 'resume' || action === 'converge'
      || Boolean(executionResult),
    retry: {
      ...qualificationRetry,
      onProgress: qualificationFenceProgress,
      onSynchronousProgress: qualificationSynchronousFence,
    },
  }) : Object.freeze({ status: 'qualification_preparation_unavailable', inspection: null });
  const goldenQualificationPublication = action !== 'status'
    && preparation && campaignReleaseAuthority
    && goldenQualificationController?.kind === 'GoldenCampaignQualificationController'
    ? await goldenQualificationController.finalize({
      externalQualification,
      campaign,
      campaignReleaseAuthority,
      preparation,
      qualificationStateStore,
      evaluateEligibility: (inspection) => evaluateAutonomousResearchCampaignQualification({
        preparation,
        campaignReleaseAuthority,
        inspection,
      }),
    }) : null;
  const effectiveQualificationInspection = goldenQualificationPublication
    ? (goldenQualificationPublication.ready === true
      && goldenQualificationPublication.pointerPublished === true
      ? goldenQualificationPublication.inspection : externalQualification.inspection)
    : externalQualification.inspection;
  const qualificationEligibility = preparation ? evaluateAutonomousResearchCampaignQualification({
    preparation,
    campaignReleaseAuthority,
    inspection: effectiveQualificationInspection,
  }) : null;
  const boundedGoldenQualificationPublished =
    goldenQualificationPublication?.status === 'golden_campaign_qualification_published'
    && goldenQualificationPublication?.ready === true
    && goldenQualificationPublication?.pointerPublished === true
    && qualificationEligibility?.boundedGoldenCapabilityQualificationVerified === true
    && qualificationEligibility?.campaignFullyQualified !== true
    && qualificationEligibility?.fullAutomaticResearchWritingReady !== true;
  const submission = await resolveAutonomousResearchCampaignSubmission({
    action,
    campaign,
    campaignId,
    preparation,
    campaignReleaseAuthority,
    qualificationEligibility,
    qualificationInspection: effectiveQualificationInspection,
    autonomousSubmissionPortal,
    autonomousSubmissionOutbox,
    autonomousVenueComplianceInspector,
    autonomousSubmissionRequestVerifier,
    requestedAt: action === 'status'
      ? null : autonomousResearchCampaignDispatchAuthorizationTime(runtime).toISOString(),
    signal: runtime?.signal || null,
    assertExternalSideEffectReady:
      runtime?.assertExternalSideEffectReady || null,
  });
  const campaignFullyQualified = submission.researchQualificationReady;
  const payload = {
    version: 1,
    kind: 'AutonomousResearchCampaignExecutionReport',
    status: submission.campaignExecutionStatus,
    action,
    campaignId,
    campaign: presentCampaignStatus(campaign, nodes),
    run: executionResult ? summarizeRun(executionResult) : null,
    campaignReleaseAuthorityAvailable: Boolean(campaignReleaseAuthority),
    externalQualification,
    goldenQualificationPublication,
    qualificationEligibility,
    boundedGoldenQualificationPublished,
    autonomousExecutionLaunchReady:
      qualificationEligibility?.autonomousExecutionLaunchReady === true,
    campaignFullyQualified,
    researchQualificationReady: submission.researchQualificationReady,
    submissionRequired: submission.submissionRequired,
    submissionReady: submission.submissionReady,
    submissionTerminalFailure: submission.submissionTerminalFailure,
    fullAutomaticResearchWritingReady: submission.fullAutomaticResearchWritingReady,
    providerConfigurationBinding,
    launchModeGate,
    operatorApprovalClaimed: false,
    autonomousSubmission: submission.autonomousSubmission,
    externalSubmissionPerformed:
      submission.autonomousSubmission?.receipt?.externalActionPerformed === true,
    selfSignedExternalQualification: false,
    automaticBudgetExpansionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchCampaignExecutionReportHash:
      hashRecord('AutonomousResearchCampaignExecutionReport', payload),
  });
}

export async function executeAutonomousResearchCampaign({
  action = 'launch',
  readinessReport = null,
  campaignId = null,
  datasetMounts = [],
  budgets = {},
  campaignStore,
  executor = null,
  workspaceMaterializer = null,
  preparedMaterialization = null,
  campaignRunner = runPaperCampaign,
  campaignReleaseAuthorityReader = null,
  externalQualificationClient = null,
  externalQualificationVerifier = null,
  qualificationStateStore = null,
  qualificationRetry = {},
  providerConfigurationBinding = null,
  launchModeGate = null,
  supervisorDispatchAuthorization = null,
  goldenQualificationController = null,
  autonomousSubmissionPortal = null,
  autonomousSubmissionOutbox = null,
  autonomousVenueComplianceInspector = null,
  autonomousSubmissionRequestVerifier = null,
  runtime = {},
} = {}) {
  const store = requireCampaignStore(campaignStore);
  if (!['launch', 'status', 'resume', 'converge'].includes(action)) {
    throw new Error(`autonomous_research_campaign_action_invalid:${action}`);
  }
  const preparation = loopPreparationFrom(readinessReport);
  const id = campaignId || (preparation?.proposal?.paperId
    ? `autonomous-research:${preparation.proposal.paperId}` : null);
  if (!id) throw new Error('autonomous_research_campaign_id_required');
  let campaign = store.getCampaign(id);
  let executionResult = null;
  let dispatchAuthorizationConsumed = false;
  if (campaign) {
    requireAutonomousResearchCampaignDispatchAuthorization({
      campaign,
      action,
      authorization: supervisorDispatchAuthorization,
      runtime,
    });
  }
  if (['launch', 'converge'].includes(action) && !campaign) {
    if (preparation?.autonomousExecutionLaunchReady !== true || typeof executor?.execute !== 'function') {
      throw new Error('autonomous_research_campaign_launch_dependencies_not_ready');
    }
    const materialization = preparedMaterialization
      || (typeof workspaceMaterializer === 'function'
        ? await workspaceMaterializer({ loopPreparation: preparation, datasetMounts }) : null);
    const plan = buildAutonomousResearchCampaignPlan({
      loopPreparation: preparation, materialization, datasetMounts, campaignId: id, budgets,
    });
    if (plan?.campaignId !== id
      || plan?.scientificClaimAuthority?.autonomousResearchSeedBindingHash
        !== preparation.seedBinding.autonomousResearchSeedBindingHash) {
      throw new Error('autonomous_research_prepared_campaign_plan_invalid');
    }
    campaign = store.createCampaign(plan);
  }
  if (!campaign) throw new Error(`autonomous_research_campaign_not_found:${id}`);
  const convergeResumeRequested = action === 'converge'
    && ['paused', 'stopped'].includes(campaign.status);
  const resumeTransitionRequested = ['resume', 'converge'].includes(action)
    && ['paused', 'stopped'].includes(campaign.status);
  if (convergeResumeRequested
    && !hasExplicitBudgetConfiguration(budgets)) {
    throw new Error('autonomous_research_converge_resume_budget_configuration_required');
  }
  if (resumeTransitionRequested && typeof executor?.execute !== 'function') {
    throw new Error('autonomous_research_campaign_executor_required');
  }
  if (['resume', 'converge'].includes(action)
    && ['paused', 'stopped'].includes(campaign.status)) {
    const previousPlanHash = campaign.spec?.campaignPlanHash || null;
    dispatchAuthorizationConsumed = requireAutonomousResearchCampaignDispatchAuthorization({
      campaign,
      action,
      authorization: supervisorDispatchAuthorization,
      runtime,
      consume: true,
    });
    campaign = store.resumeCampaign(id, { budgetOverrides: budgets });
    if (dispatchAuthorizationConsumed
      && campaign.spec?.campaignPlanHash !== previousPlanHash) {
      throw new Error('autonomous_research_supervisor_dispatch_authorization_plan_changed');
    }
  }
  const shouldRun = action !== 'status' && campaign.status === 'running';
  if (shouldRun) {
    if (typeof executor?.execute !== 'function') throw new Error('autonomous_research_campaign_executor_required');
    if (!dispatchAuthorizationConsumed) {
      dispatchAuthorizationConsumed = requireAutonomousResearchCampaignDispatchAuthorization({
        campaign,
        action,
        authorization: supervisorDispatchAuthorization,
        runtime,
        consume: true,
      });
    }
    executionResult = await campaignRunner({
      campaignId: id,
      campaignStore: store,
      executor,
      ...runtime,
    });
  } else if (action === 'resume' && !SETTLED.has(campaign.status) && campaign.status !== 'paused') {
    throw new Error(`autonomous_research_campaign_resume_state_invalid:${campaign.status}`);
  }
  if (!dispatchAuthorizationConsumed) {
    requireAutonomousResearchCampaignDispatchAuthorization({
      campaign,
      action,
      authorization: supervisorDispatchAuthorization,
      runtime,
      consume: true,
    });
  }
  return executionReport({
    action,
    campaignStore: store,
    campaignId: id,
    executionResult,
    campaignReleaseAuthorityReader,
    externalQualificationClient,
    externalQualificationVerifier,
    qualificationStateStore,
    qualificationRetry: {
      ...qualificationRetry,
      clock: qualificationRetry.clock || runtime.clock,
      scheduler: qualificationRetry.scheduler || runtime.scheduler,
      signal: qualificationRetry.signal || runtime.signal || null,
    },
    providerConfigurationBinding,
    launchModeGate,
    goldenQualificationController,
    autonomousSubmissionPortal,
    autonomousSubmissionOutbox,
    autonomousVenueComplianceInspector,
    autonomousSubmissionRequestVerifier,
    runtime,
  });
}
