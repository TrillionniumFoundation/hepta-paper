import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildCampaignModeNodes } from '../../paper-domain/automation/campaign-mode-graph.mjs';
import {
  buildDeterministicAutonomousHypothesisDraft,
  createAutonomousHypothesisGenerationReceipt,
  createMachineProposedScientificClaimSet,
  selectDeterministicAutonomousResearchAgenda,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  buildAutonomousResearchSeedBinding,
  buildAutonomousResearchSeedContractBundle,
  evaluateAutonomousResearchPolicy,
} from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import {
  evaluateAutonomousCampaignTopology,
  evaluateAutonomousDatasetLaunchReadiness,
  evaluateAutonomousResearchPrincipalSeparation,
  evaluateAutonomousResearchQualificationEligibility,
} from '../../paper-domain/automation/autonomous-research-readiness-policy.mjs';
import {
  selectAutonomousEmpiricalExecutionProfile,
} from '../../paper-domain/automation/autonomous-empirical-execution-profile-policy.mjs';
import {
  AUTONOMOUS_RESEARCH_LAUNCH_MODES,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  verifyAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';

async function generateHypothesis({
  hypothesisGenerator,
  paperId,
  objective,
  protocolFamily,
} = {}) {
  if (!hypothesisGenerator) {
    return Object.freeze({
      draft: buildDeterministicAutonomousHypothesisDraft({ objective, protocolFamily }),
      principalId: 'hepta-autonomous-hypothesis-generator:v1',
      provider: 'local-deterministic-policy',
      model: null,
      externalActionPerformed: false,
    });
  }
  if (typeof hypothesisGenerator.generate !== 'function') {
    throw new Error('autonomous_research_hypothesis_generator_invalid');
  }
  const generated = await hypothesisGenerator.generate({ paperId, objective, protocolFamily });
  if (!generated?.draft) throw new Error('autonomous_research_hypothesis_generator_output_missing');
  return Object.freeze({
    draft: generated.draft,
    principalId: generated.principalId,
    provider: generated.provider,
    model: generated.model || null,
    externalActionPerformed: Boolean(generated.externalActionPerformed),
  });
}

function buildCampaignTopologyTemplate({
  paperId,
  revisionRounds,
  refereeCount,
  empiricalExecutionProfileSelection,
} = {}) {
  const executionIntent = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchCampaignExecutionIntent',
    formalVerificationRequired: true,
    empiricalVerificationRequired: true,
    researchVerificationRequired: true,
    externalSubmissionEnabled: false,
  });
  const nodes = buildCampaignModeNodes({
    campaignId: `autonomous-research:${paperId}`,
    mode: 'full-campaign',
    rounds: revisionRounds,
    reviewers: refereeCount,
    executionProfiles: Object.freeze([
      empiricalExecutionProfileSelection.executionProfile,
    ]),
    executionIntent,
    empiricalRequested: true,
    applyManuscript: true,
    formalRequested: true,
    researchVerificationRequired: true,
  });
  return Object.freeze({
    version: 2,
    kind: 'AutonomousResearchCampaignTopologyTemplate',
    campaignId: `autonomous-research:${paperId}`,
    paperId,
    revisionRounds,
    refereeCount,
    empiricalExecutionProfileSelectionHash:
      empiricalExecutionProfileSelection.autonomousEmpiricalExecutionProfileSelectionHash,
    empiricalExecutionProfile: empiricalExecutionProfileSelection.executionProfile,
    executionIntent,
    nodes,
    externalSubmissionEnabled: false,
    autonomousResearchCampaignTopologyTemplateHash:
      hashRecord('AutonomousResearchCampaignTopologyTemplate', {
        version: 2,
        kind: 'AutonomousResearchCampaignTopologyTemplate',
        campaignId: `autonomous-research:${paperId}`,
        paperId,
        revisionRounds,
        refereeCount,
        empiricalExecutionProfileSelectionHash:
          empiricalExecutionProfileSelection.autonomousEmpiricalExecutionProfileSelectionHash,
        empiricalExecutionProfile: empiricalExecutionProfileSelection.executionProfile,
        executionIntent,
        nodes,
        externalSubmissionEnabled: false,
      }),
  });
}

export async function prepareAutonomousResearchLoop({
  paperId,
  objective,
  protocolFamily,
  hypothesisGenerator = null,
  authorPrincipal = null,
  formalReviewerPrincipal = null,
  campaignReleaseAuthority = null,
  revisionRounds = 3,
  refereeCount = 3,
  humanSubjects = false,
  privateData = false,
  datasetMounts = [],
  datasetAuthorityReceipt = null,
  empiricalRuntimeCapabilityInspection = null,
  autonomousResearchProviderConfigurationHash = null,
  machineIntake = null,
  machineIntakeAdmission = null,
  launchMode = AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP,
  createdAt = null,
} = {}) {
  if (!Object.values(AUTONOMOUS_RESEARCH_LAUNCH_MODES).includes(launchMode)) {
    throw new Error(`autonomous_research_launch_mode_invalid:${launchMode || '<empty>'}`);
  }
  if (Boolean(machineIntake) !== Boolean(machineIntakeAdmission)
    || (machineIntakeAdmission && (
      !verifyAutonomousResearchMachineIntakeAdmission(machineIntakeAdmission, {
        intake: machineIntake,
      })
      || machineIntakeAdmission.paperId !== paperId
      || machineIntakeAdmission.campaignId !== `autonomous-research:${paperId}`
    ))) {
    throw new Error('autonomous_research_machine_intake_admission_binding_invalid');
  }
  const datasetAuthorityConstraintInspection = evaluateAutonomousDatasetLaunchReadiness({
    protocolFamily: datasetAuthorityReceipt?.benchmarkFamily || null,
    datasetMounts,
    datasetAuthorityReceipt,
  });
  const datasetAuthorityProtocolFamily = datasetAuthorityConstraintInspection.status
    === 'autonomous_research_dataset_launch_ready'
    ? datasetAuthorityReceipt.benchmarkFamily : null;
  const agendaSelectionReceipt = selectDeterministicAutonomousResearchAgenda({
    paperId,
    objective,
    protocolFamily,
    datasetAuthorityProtocolFamily,
    selectedAt: createdAt,
  });
  const selectedObjective = agendaSelectionReceipt.selectedObjective;
  const selectedProtocolFamily = agendaSelectionReceipt.selectedProtocolFamily;
  const generated = await generateHypothesis({
    hypothesisGenerator,
    paperId,
    objective: selectedObjective,
    protocolFamily: selectedProtocolFamily,
  });
  const generationReceipt = createAutonomousHypothesisGenerationReceipt({
    draft: generated.draft,
    principalId: generated.principalId,
    provider: generated.provider,
    model: generated.model,
    externalActionPerformed: generated.externalActionPerformed,
    generatedAt: createdAt,
  });
  const proposal = createMachineProposedScientificClaimSet({
    paperId,
    objective: selectedObjective,
    protocolFamily: selectedProtocolFamily,
    draft: generated.draft,
    generationReceipt,
    agendaSelectionReceipt,
    createdAt,
  });
  const policyAuthorization = evaluateAutonomousResearchPolicy({
    proposal,
    agendaSelectionReceipt,
    humanSubjects,
    privateData,
    externalDatasetAuthorityVerified: Boolean(datasetAuthorityProtocolFamily),
    externalSubmissionRequested: false,
    requestedRevisionRounds: revisionRounds,
    requestedRefereeCount: refereeCount,
    evaluatedAt: createdAt,
  });
  const seedBundle = buildAutonomousResearchSeedContractBundle({
    proposal,
    policyAuthorization,
    evidencePlan: [
      'Bind every manuscript empirical result to verified original and replay artifact hashes.',
      'Bind every formal claim to a kernel-checked proof certificate and replay receipt.',
    ],
    reproducibilityPlan: [
      'Preserve code, runtime image, dataset authority, protocol, seed, and output identities by hash.',
      'Require a fresh isolated deterministic rerun before research promotion; do not describe it as independent scientific replication.',
    ],
    createdAt,
  });
  const seedBinding = buildAutonomousResearchSeedBinding({ seedBundle });
  const empiricalExecutionProfileSelection = selectAutonomousEmpiricalExecutionProfile({
    protocolFamily: proposal.protocolFamily,
    runtimeCapabilityInspection: empiricalRuntimeCapabilityInspection,
  });
  const topologyTemplate = buildCampaignTopologyTemplate({
    paperId: proposal.paperId,
    revisionRounds: Number(revisionRounds),
    refereeCount: Number(refereeCount),
    empiricalExecutionProfileSelection,
  });
  const topologyInspection = evaluateAutonomousCampaignTopology({ nodes: topologyTemplate.nodes });
  const principalSeparation = evaluateAutonomousResearchPrincipalSeparation({
    authorPrincipal,
    formalReviewerPrincipal,
  });
  const datasetLaunchInspection = evaluateAutonomousDatasetLaunchReadiness({
    protocolFamily: proposal.protocolFamily,
    datasetMounts,
    datasetAuthorityReceipt,
  });
  const qualificationEligibility = evaluateAutonomousResearchQualificationEligibility({
    proposal,
    policyAuthorization,
    seedBundle,
    seedBinding,
    principalSeparation,
    topologyInspection,
    datasetLaunchInspection,
    empiricalRuntimeCapabilityInspection,
    empiricalExecutionProfileSelection,
    campaignReleaseAuthority,
    fullResearchQualificationInspection: null,
  });
  const payload = {
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
    status: qualificationEligibility.status,
    proposal,
    generationReceipt,
    policyAuthorization,
    seedBundle,
    seedBinding,
    launchMode,
    autonomousResearchProviderConfigurationHash,
    ...(machineIntakeAdmission ? {
      autonomousResearchMachineIntakeAdmission: machineIntakeAdmission,
      autonomousResearchMachineIntakeAdmissionHash:
        machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    } : {}),
    empiricalRuntimeCapabilityInspection,
    empiricalExecutionProfileSelection,
    principalSeparation,
    topologyTemplate,
    topologyInspection,
    datasetLaunchInspection,
    qualificationEligibility,
    autonomousExecutionLaunchReady: qualificationEligibility.autonomousExecutionLaunchReady,
    autonomousPolicyReady: policyAuthorization.status === 'machine_proposal_policy_authorized',
    qualificationRequestEligible: qualificationEligibility.qualificationRequestEligible,
    campaignFullyQualified: false,
    fullAutomaticResearchWritingReady: false,
    safety: Object.freeze({
      machineProposed: true,
      operatorApprovalClaimed: false,
      selfSignedExternalTrustClaimed: false,
      externalSubmissionEnabled: false,
      universalResearchValidityClaimed: false,
      naturalLanguageToLeanEquivalenceMachineProven: false,
    }),
    createdAt: createdAt || null,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchLoopPreparationReportHash:
      hashRecord('AutonomousResearchLoopPreparationReport', payload),
  });
}
