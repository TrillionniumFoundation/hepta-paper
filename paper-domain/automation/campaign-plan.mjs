import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { normalizeDatasetMounts } from './empirical-contract.mjs';
import { buildCampaignBenchmarkSelector } from './campaign-benchmark-selector.mjs';
import { buildCampaignResearchVerificationInput } from './campaign-research-contract.mjs';
import {
  buildCampaignModeNodes,
  empiricalExecutionProfiles,
  plannedAgentCallUpperBound,
  plannedBenchmarkCellJobUpperBounds,
} from './campaign-mode-graph.mjs';
import { PAPER_BATCH_MODES } from '../workflow/mode-registry.mjs';
import { normalizePaperQualityProfiles } from '../quality/paper-quality-profile-set.mjs';
import { verifyAutonomousEmpiricalExecutionProfileSelection } from './autonomous-empirical-execution-profile-policy.mjs';
import { verifyAutonomousResearchMachineIntake } from './autonomous-research-machine-intake-contract.mjs';
import { verifyAutonomousResearchMachineIntakeAdmission } from './autonomous-research-machine-intake-admission-contract.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from './autonomous-research-agenda-production-contract.mjs';
import {
  inspectAutonomousResearchProductionProfilePreparation,
} from './autonomous-research-production-profile-contract.mjs';
import { verifyVenueRequirementIr } from './venue-requirement-ir.mjs';
import {
  verifyResearchAgendaClaimBindingReceipt,
} from './research-agenda-claim-binding-contract.mjs';
import { assertAutonomousResearchDirectLocalRunBudgetWaiverBinding } from './autonomous-research-launch-mode-policy.mjs';
const FULL_CAMPAIGN_MODE = 'full-campaign';
const ACADEMIC_EMPIRICAL_ASSURANCE_SCOPE = 'operator-authorized-hidden-evaluation-v1';
const UNSUPPORTED_BATCH_MODES = new Set([
  PAPER_BATCH_MODES.JOURNAL_MANAGE,
  PAPER_BATCH_MODES.VENUE_RESOLVE,
  PAPER_BATCH_MODES.SOURCE_ADAPT,
]);
function normalizeOptional(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
function normalizeVenueTarget(value) {
  const venueTarget = normalizeOptional(value);
  if (!venueTarget) return null;
  if (venueTarget.length > 256 || [...venueTarget].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 32 || codePoint === 127;
  })) {
    throw new Error('campaign_venue_target_invalid');
  }
  return venueTarget;
}

function approvedProposalSeedBinding(paperTask, { formalRequested = false } = {}) {
  if (paperTask?.registry?.inventorySource !== 'proposal_materialization') return null;
  const contractPath = normalizeOptional(paperTask?.source?.proposalSeedContracts);
  const proposalEnvelopeHash = normalizeOptional(paperTask?.registry?.proposalEnvelopeHash);
  const productionPlanEnvelopeHash = normalizeOptional(paperTask?.registry?.productionPlanEnvelopeHash);
  const reviewGateHash = normalizeOptional(paperTask?.registry?.reviewGateHash);
  const proposalSeedContractBundleHash = normalizeOptional(paperTask?.registry?.proposalSeedContractBundleHash);
  if (formalRequested && (!contractPath || !proposalEnvelopeHash || !productionPlanEnvelopeHash
    || !reviewGateHash || !proposalSeedContractBundleHash)) {
    throw new Error('campaign_formal_proposal_seed_binding_required');
  }
  if (!contractPath) return null;
  const payload = {
    version: 1,
    kind: 'ApprovedProposalSeedBinding',
    status: 'approved_proposal_seed_bound',
    contractPath,
    proposalEnvelopeHash,
    productionPlanEnvelopeHash,
    reviewGateHash,
    proposalSeedContractBundleHash,
  };
  return Object.freeze({
    ...payload,
    approvedProposalSeedBindingHash: hashRecord('ApprovedProposalSeedBinding', payload),
  });
}

function autonomousScientificClaimAuthority(value, paperId) {
  if (value === null || value === undefined) return null;
  const { autonomousResearchSeedBindingHash: claimedHash, ...payload } = value || {};
  if (value?.version !== 1 || value?.kind !== 'AutonomousResearchSeedBinding'
    || value?.status !== 'autonomous_research_seed_bound'
    || value?.claimAuthorityType !== 'machine-policy-authorized'
    || value?.paperId !== paperId || !value?.contractPath || value?.blockers?.length
    || hashRecord('AutonomousResearchSeedBinding', payload) !== claimedHash) {
    throw new Error('campaign_autonomous_scientific_claim_authority_invalid');
  }
  return value;
}

function autonomousPreparation(value, { paperId, scientificClaimAuthority } = {}) {
  if (value === null || value === undefined) return null;
  const { autonomousResearchLoopPreparationReportHash: claimedHash, ...payload } = value || {};
  const capabilityScope = value?.capabilityScopeManifest || null;
  const machineGeneratedAgendaValid = capabilityScope?.agendaMode !== 'machine-generated'
    || (verifyAutonomousResearchAgendaProductionReceipt(
      value?.researchAgendaProducerReceipt,
    ).valid
      && capabilityScope.empiricalFamilies.includes(
        value.researchAgendaProducerReceipt.selectedProtocolFamily,
      ));
  const productionProfileInspection =
    inspectAutonomousResearchProductionProfilePreparation(value);
  const venueRequirementIrValid = value?.venueRequirementIr === undefined
    || verifyVenueRequirementIr(value.venueRequirementIr, {
      researchAgendaIr: value.researchAgendaIr,
      venueProfile: value.venueProfileSelection?.profile || null,
      venueProfileSelection: value.venueProfileSelection || null,
    });
  const agendaClaimBindingValid = value?.researchAgendaIr === undefined
    ? value?.agendaClaimBindingReceipt === undefined
    : verifyResearchAgendaClaimBindingReceipt(value?.agendaClaimBindingReceipt, {
      researchAgendaIr: value.researchAgendaIr,
      proposal: value.proposal,
    }).valid;
  if (value?.version !== 1 || value?.kind !== 'AutonomousResearchLoopPreparationReport'
    || value?.paperId !== undefined
    || value?.proposal?.paperId !== paperId
    || !['golden-bootstrap', 'production-run'].includes(value?.launchMode)
    || value?.autonomousExecutionLaunchReady !== true
    || value?.seedBinding?.autonomousResearchSeedBindingHash
      !== scientificClaimAuthority?.autonomousResearchSeedBindingHash
    || !machineGeneratedAgendaValid
    || !agendaClaimBindingValid
    || !venueRequirementIrValid
    || !productionProfileInspection.ready
    || (capabilityScope?.genericDeclaredCapability === true
      && capabilityScope?.manuscriptMode !== 'agent-authored-evidence-bound-ir-v1')
    || !verifyAutonomousEmpiricalExecutionProfileSelection(
      value?.empiricalExecutionProfileSelection,
      {
        protocolFamily: value?.proposal?.protocolFamily,
        requireReady: true,
        runtimeCapabilityInspection: value?.empiricalRuntimeCapabilityInspection,
        requireRuntimeCapabilityInspection: true,
        runtimeReproducibilityInspection:
          value?.runtimeImageReproducibilityInspection,
        requireRegisteredRuntime: value?.launchMode === 'production-run',
        observedAt: value?.createdAt,
      },
    )
    || hashRecord('AutonomousResearchLoopPreparationReport', payload) !== claimedHash) {
    throw new Error('campaign_autonomous_research_preparation_invalid');
  }
  return value;
}

function machineIntakeExecutionAdmission({
  preparation,
  machineIntake,
  machineIntakeAdmission,
} = {}) {
  if (!machineIntake) return null;
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchCampaignExecutionAdmission',
    status: 'autonomous_research_campaign_admitted_not_authorized',
    initialCampaignStatus: 'paused',
    launchMode: preparation.launchMode,
    supervisorDispatchAuthorizationRequired: true,
    autonomousResearchMachineIntakeHash: machineIntake.intakeHash,
    autonomousResearchMachineIntakeAdmissionHash:
      machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    providerConfigurationHash: preparation.autonomousResearchProviderConfigurationHash,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchCampaignExecutionAdmissionHash: hashRecord(
      'AutonomousResearchCampaignExecutionAdmission',
      payload,
    ),
  });
}

function canonicalCampaignMode(requestedMode) {
  const requested = normalizeOptional(requestedMode) || FULL_CAMPAIGN_MODE;
  if (requested === PAPER_BATCH_MODES.INVENTORY) throw new Error('campaign_inventory_mode_has_no_execution_plan');
  if (UNSUPPORTED_BATCH_MODES.has(requested)) throw new Error(`campaign_mode_executor_not_available:${requested}`);
  if (requested === PAPER_BATCH_MODES.REFEREE_AUTOPILOT) return PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP;
  const supported = new Set([
    FULL_CAMPAIGN_MODE,
    PAPER_BATCH_MODES.LOCAL_BUILD,
    PAPER_BATCH_MODES.LOCAL_PACKAGE,
    PAPER_BATCH_MODES.REFEREE_REVIEW,
    PAPER_BATCH_MODES.REFEREE_REVISE,
    PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP,
    PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS,
    PAPER_BATCH_MODES.RESEARCH_VERIFY,
    PAPER_BATCH_MODES.LOCAL_DRY_RUN,
    PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  ]);
  if (!supported.has(requested)) throw new Error(`campaign_mode_unknown:${requested}`);
  return requested;
}

export function assertPaperCampaignModeExecutable(mode) {
  return canonicalCampaignMode(mode);
}

export function assertAcademicEmpiricalExecutionProfileBijection({
  academicEmpiricalSelector = false,
  executionProfiles = [],
} = {}) {
  if (academicEmpiricalSelector && executionProfiles.length !== 1) {
    throw new Error('campaign_academic_empirical_requires_exactly_one_execution_profile');
  }
}

export function buildPaperCampaignPlan({
  paperId,
  sourceWorkspace,
  maxRounds = 3,
  refereeCount = 3,
  languages = ['latex'],
  campaignId = null,
  requiresGpu = false,
  budgets = {},
  datasetMounts = [],
  minimumRevisionRounds = 1,
  parentCampaignId = null,
  supersedesCampaignId = null,
  recoveryOfCampaignId = null,
  metricSchema = {},
  paperQualityProfile = null,
  paperQualityProfiles = [],
  commandBinding = null,
  mode = FULL_CAMPAIGN_MODE,
  venueTarget = null,
  datasetRoot = null,
  benchmarkId = null,
  applyManuscript = false,
  paperTask = null,
  paperState = null,
  empiricalClaimUniverse = null,
  scientificClaimAuthority = null,
  autonomousResearchPreparation = null,
  autonomousResearchMachineIntake = null,
  autonomousResearchMachineIntakeAdmission = null,
  localOnly = false,
  directLocalRunBudgetWaiver = null,
} = {}) {
  if (!paperId || !sourceWorkspace) throw new Error('paperId and sourceWorkspace are required');
  const requestedMode = normalizeOptional(mode) || FULL_CAMPAIGN_MODE;
  const effectiveMode = canonicalCampaignMode(requestedMode);
  const requestedRounds = Math.max(1, Math.min(10, Number(maxRounds) || 3));
  const roundDrivenMode = [FULL_CAMPAIGN_MODE, PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP].includes(effectiveMode);
  const rounds = roundDrivenMode ? requestedRounds : 1;
  const reviewers = Math.max(2, Math.min(7, Number(refereeCount) || 3));
  const id = campaignId || `paper-campaign:${paperId}`;
  const inferredRecovery = id.includes(':recovery-') ? id.slice(0, id.indexOf(':recovery-')) : null;
  const normalizedLanguages = [...new Set(languages.map((language) => String(language).trim().toLowerCase()).filter(Boolean))];
  const normalizedMounts = normalizeDatasetMounts(datasetMounts);
  const empiricalEvidenceRequested = Boolean(normalizedMounts.length || normalizeOptional(benchmarkId));
  const effectivePaperQualityProfiles = normalizePaperQualityProfiles([
    paperQualityProfile,
    paperQualityProfiles,
    paperTask?.paperQualityProfile,
    paperTask?.paperQualityProfiles,
  ], {
    languages: normalizedLanguages,
    inferFromPaper: Boolean(paperTask),
    empiricalEvidenceRequested,
  });
  const effectivePaperQualityProfile = effectivePaperQualityProfiles[0] || null;
  const formalRequested = effectivePaperQualityProfiles.includes('formal_theorem_or_proof');
  const approvedProposalSeed = approvedProposalSeedBinding(paperTask, { formalRequested });
  const explicitScientificClaimAuthority = autonomousScientificClaimAuthority(
    scientificClaimAuthority,
    paperId,
  );
  if (approvedProposalSeed && explicitScientificClaimAuthority) {
    throw new Error('campaign_scientific_claim_authority_ambiguous');
  }
  if (explicitScientificClaimAuthority && !formalRequested) {
    throw new Error('campaign_autonomous_scientific_claim_authority_requires_formal_profile');
  }
  const explicitAutonomousPreparation = autonomousPreparation(autonomousResearchPreparation, {
    paperId,
    scientificClaimAuthority: explicitScientificClaimAuthority,
  });
  if (Boolean(explicitScientificClaimAuthority) !== Boolean(explicitAutonomousPreparation)) {
    throw new Error('campaign_autonomous_research_authority_preparation_pair_required');
  }
  if (Boolean(autonomousResearchMachineIntake)
      !== Boolean(autonomousResearchMachineIntakeAdmission)
    || (autonomousResearchMachineIntake
    && (!verifyAutonomousResearchMachineIntake(autonomousResearchMachineIntake)
      || !verifyAutonomousResearchMachineIntakeAdmission(
        autonomousResearchMachineIntakeAdmission,
        { intake: autonomousResearchMachineIntake },
      )
      || !explicitAutonomousPreparation
      || autonomousResearchMachineIntake.paperId !== paperId
      || autonomousResearchMachineIntake.campaignId !== id
      || autonomousResearchMachineIntake.launchMode !== explicitAutonomousPreparation.launchMode
      || autonomousResearchMachineIntake.providerConfigurationHash
        !== explicitAutonomousPreparation.autonomousResearchProviderConfigurationHash
      || explicitAutonomousPreparation.autonomousResearchMachineIntakeAdmissionHash
        !== autonomousResearchMachineIntakeAdmission
          .autonomousResearchMachineIntakeAdmissionHash))) {
    throw new Error('campaign_autonomous_research_machine_intake_binding_invalid');
  }
  const executionAdmission = machineIntakeExecutionAdmission({
    preparation: explicitAutonomousPreparation,
    machineIntake: autonomousResearchMachineIntake,
    machineIntakeAdmission: autonomousResearchMachineIntakeAdmission,
  });
  const empiricalAuthorityRequired = effectivePaperQualityProfiles.includes('empirical_or_experiment');
  const executionProfiles = empiricalExecutionProfiles(normalizedLanguages, requiresGpu, { excludeLean: formalRequested });
  if (explicitAutonomousPreparation) {
    const selectedProfile = explicitAutonomousPreparation.empiricalExecutionProfileSelection.executionProfile;
    if (executionProfiles.length !== 1
      || JSON.stringify(executionProfiles[0]) !== JSON.stringify(selectedProfile)) {
      throw new Error('campaign_autonomous_empirical_execution_profile_mismatch');
    }
  }
  const releaseEmpiricalExecutionRequired = effectiveMode === FULL_CAMPAIGN_MODE && executionProfiles.length > 0;
  const effectiveDatasetRoot = normalizedMounts[0]?.source || normalizeOptional(datasetRoot);
  if (effectiveDatasetRoot && !normalizedMounts.length) throw new Error('campaign_dataset_root_requires_verified_mount');
  const empiricalRequested = Boolean(normalizedMounts.length || normalizeOptional(benchmarkId) || applyManuscript);
  const empiricalModes = new Set([FULL_CAMPAIGN_MODE, PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS, PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP]);
  if (empiricalRequested && !empiricalModes.has(effectiveMode)) {
    throw new Error(`campaign_empirical_options_not_supported_for_mode:${requestedMode}`);
  }
  const effectiveBenchmarkId = normalizeOptional(benchmarkId) || (normalizedMounts.length === 1 ? normalizedMounts[0].name : null);
  const benchmarkSelector = buildCampaignBenchmarkSelector({
    benchmarkId: effectiveBenchmarkId,
    datasetMounts: normalizedMounts,
    empiricalClaimUniverse,
  });
  if (empiricalClaimUniverse && !benchmarkSelector) {
    throw new Error('campaign_empirical_claim_universe_requires_benchmark_selector');
  }
  if (empiricalAuthorityRequired && !benchmarkSelector) {
    throw new Error('campaign_empirical_profile_requires_benchmark_selector');
  }
  if (normalizedMounts.length && (empiricalAuthorityRequired || releaseEmpiricalExecutionRequired)
    && (normalizedMounts.length !== 1 || benchmarkSelector?.selectorType !== 'authorized_dataset_mount'
      || benchmarkSelector.datasetMountName !== normalizedMounts[0].name)) {
    throw new Error('campaign_empirical_dataset_requires_unique_benchmark_selector');
  }
  if (benchmarkSelector && !executionProfiles.length) throw new Error('campaign_benchmark_requires_empirical_execution_profile');
  const academicEmpiricalSelector = benchmarkSelector?.selectorType === 'authorized_dataset_mount'
    && benchmarkSelector.assuranceScope === ACADEMIC_EMPIRICAL_ASSURANCE_SCOPE;
  assertAcademicEmpiricalExecutionProfileBijection({ academicEmpiricalSelector, executionProfiles });
  if (releaseEmpiricalExecutionRequired && !academicEmpiricalSelector) {
    throw new Error('campaign_release_empirical_requires_academic_authorized_dataset_selector');
  }
  const canonicalVenueTarget = normalizeVenueTarget(venueTarget || paperTask?.venueTarget);
  if (effectiveMode === PAPER_BATCH_MODES.REVIEWED_SUBMIT && !canonicalVenueTarget) {
    throw new Error('campaign_reviewed_submit_venue_target_required');
  }
  const researchVerificationModes = new Set([
    FULL_CAMPAIGN_MODE,
    PAPER_BATCH_MODES.LOCAL_PACKAGE,
    PAPER_BATCH_MODES.RESEARCH_VERIFY,
    PAPER_BATCH_MODES.LOCAL_DRY_RUN,
    PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  ]);
  const researchVerificationRequired = researchVerificationModes.has(effectiveMode);
  const researchVerificationInput = researchVerificationRequired && paperTask
    ? buildCampaignResearchVerificationInput({
      paperId,
      paperTask: { ...paperTask, paperQualityProfile: effectivePaperQualityProfile, paperQualityProfiles: effectivePaperQualityProfiles },
      paperState,
    })
    : null;
  if (researchVerificationRequired && !researchVerificationInput && effectiveMode !== FULL_CAMPAIGN_MODE) {
    throw new Error('campaign_research_verification_input_required');
  }
  const executionIntent = Object.freeze({
    version: 2,
    kind: 'PaperCampaignModeIntent',
    requestedMode: effectiveMode,
    effectiveMode,
    requestedMaxRounds: requestedRounds,
    effectiveMaxRounds: rounds,
    venueTarget: canonicalVenueTarget,
    datasetRoot: effectiveDatasetRoot,
    datasetMountNames: Object.freeze(normalizedMounts.map((mount) => mount.name)),
    benchmarkId: benchmarkSelector?.benchmarkId || null,
    benchmarkSelectorHash: benchmarkSelector?.campaignBenchmarkSelectorHash || null,
    applyManuscript: Boolean(applyManuscript),
    paperQualityProfile: effectivePaperQualityProfile,
    paperQualityProfiles: effectivePaperQualityProfiles,
    paperQualityRequirements: Object.freeze({
      formalVerificationRequired: formalRequested,
      empiricalVerificationRequired: empiricalAuthorityRequired,
      researchVerificationRequired,
    }),
    formalVerificationRequired: formalRequested,
    empiricalVerificationRequired: empiricalAuthorityRequired,
  });
  const nodes = buildCampaignModeNodes({
    campaignId: id,
    mode: effectiveMode,
    rounds,
    reviewers,
    executionProfiles,
    executionIntent,
    empiricalRequested,
    applyManuscript: Boolean(applyManuscript),
    formalRequested,
    researchVerificationRequired,
  });
  if (!nodes.length) throw new Error(`campaign_mode_plan_empty:${requestedMode}`);
  const defaultMaxAgentCalls = Math.max(30, plannedAgentCallUpperBound(nodes));
  const plannedCellJobs = plannedBenchmarkCellJobUpperBounds(nodes, benchmarkSelector);
  const campaignBudgets = Object.freeze({
    maxWallTimeMs: Number(budgets.maxWallTimeMs ?? 6 * 60 * 60 * 1000),
    maxAgentCalls: Number(budgets.maxAgentCalls ?? defaultMaxAgentCalls),
    maxCpuJobs: Number(budgets.maxCpuJobs ?? Math.max(32, plannedCellJobs.cpu)),
    maxGpuJobs: Number(budgets.maxGpuJobs ?? Math.max(8, plannedCellJobs.gpu)),
    maxTokenCount: Number(budgets.maxTokenCount ?? 500000),
    maxCostUsd: Number(budgets.maxCostUsd ?? 100),
    maxMemoryMiB: Number(budgets.maxMemoryMiB ?? 8192),
  });
  if (localOnly === true || directLocalRunBudgetWaiver || autonomousResearchPreparation) {
    assertAutonomousResearchDirectLocalRunBudgetWaiverBinding(
      {
        launchMode: explicitAutonomousPreparation?.launchMode || null,
        localOnly,
        budgets: campaignBudgets,
        waiver: directLocalRunBudgetWaiver,
        campaignId: id,
        paperId,
        preparation: explicitAutonomousPreparation,
      },
    );
  }
  const payload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId: id,
    terminalSiblingSettlementPolicyVersion: 1,
    parentCampaignId: parentCampaignId || inferredRecovery,
    supersedesCampaignId: supersedesCampaignId || inferredRecovery,
    recoveryOfCampaignId: recoveryOfCampaignId || inferredRecovery,
    paperId,
    sourceWorkspace,
    requestedMode: effectiveMode,
    mode: effectiveMode,
    executionIntent,
    requestedMaxRounds: requestedRounds,
    maxRounds: rounds,
    refereeCount: reviewers,
    languages: normalizedLanguages,
    requiresGpu: Boolean(requiresGpu),
    paperQualityProfile: effectivePaperQualityProfile,
    paperQualityProfiles: effectivePaperQualityProfiles,
    paperQualityRequirements: executionIntent.paperQualityRequirements,
    ...(approvedProposalSeed ? { approvedProposalSeed } : {}),
    ...(explicitScientificClaimAuthority
      ? { scientificClaimAuthority: explicitScientificClaimAuthority }
      : {}),
    ...(explicitAutonomousPreparation
      ? {
        autonomousResearchPreparation: explicitAutonomousPreparation,
        autonomousEmpiricalExecutionProfileSelectionHash:
          explicitAutonomousPreparation.empiricalExecutionProfileSelection
            .autonomousEmpiricalExecutionProfileSelectionHash,
      }
      : {}),
    ...(autonomousResearchMachineIntake ? {
      autonomousResearchMachineIntake,
      autonomousResearchMachineIntakeHash: autonomousResearchMachineIntake.intakeHash,
      autonomousResearchMachineIntakeAdmission,
      autonomousResearchMachineIntakeAdmissionHash:
        autonomousResearchMachineIntakeAdmission
          .autonomousResearchMachineIntakeAdmissionHash,
      executionAdmission,
    } : {}),
    ...(localOnly === true ? { localOnly: true } : {}),
    ...(directLocalRunBudgetWaiver ? { directLocalRunBudgetWaiver } : {}),
    researchVerificationRequired,
    convergenceThresholds: { minimumRoundIndex: Math.max(1, Math.min(rounds, Number(minimumRevisionRounds || 1))) },
    venueTarget: executionIntent.venueTarget,
    datasetRoot: executionIntent.datasetRoot,
    benchmarkId: executionIntent.benchmarkId,
    benchmarkSelector,
    ...(empiricalClaimUniverse ? { empiricalClaimUniverse } : {}),
    applyManuscript: executionIntent.applyManuscript,
    ...(researchVerificationInput ? { researchVerificationInput } : {}),
    datasetMounts: normalizedMounts,
    metricSchema: {
      version: 1,
      minimumMetricCount: Math.max(1, Number(metricSchema.minimumMetricCount || 1)),
      absoluteTolerance: Math.max(0, Number(metricSchema.absoluteTolerance ?? 1e-9)),
      relativeTolerance: Math.max(0, Number(metricSchema.relativeTolerance ?? 1e-6)),
      metrics: Array.isArray(metricSchema.metrics) ? metricSchema.metrics.map((item) => ({ path: String(item.path) })) : [],
    },
    budgets: campaignBudgets,
    ...(commandBinding ? { commandBinding: Object.freeze({ ...commandBinding }) } : {}),
    nodes,
    externalSubmissionEnabled: false,
    releaseHandoffRequired: effectiveMode === PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  };
  return Object.freeze({ ...payload, campaignPlanHash: hashRecord('PaperCampaignPlan', payload) });
}
