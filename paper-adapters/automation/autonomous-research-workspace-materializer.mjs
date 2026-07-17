import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_FORMAL_MANUSCRIPT_PROOF,
  verifyMachineProposedScientificClaimSet,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import { verifyAutonomousResearchPolicyAuthorization } from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  createAutonomousEmpiricalClaimLineage,
  deriveAutonomousEmpiricalClaimMaterialization,
} from '../../paper-domain/automation/autonomous-empirical-claim-lineage-contract.mjs';
import { readEmpiricalClaimUniverse } from '../research-verify/empirical-claim-universe-reader.mjs';
import {
  verifyAutonomousEmpiricalExecutionProfileSelection,
} from '../../paper-domain/automation/autonomous-empirical-execution-profile-policy.mjs';

function latexEscape(value) {
  return String(value || '').replace(/\\/g, '\\textbackslash{}').replace(/([#$%&_{}])/g, '\\$1');
}

function manuscriptSkeleton({ proposal, empiricalMaterialization }) {
  const formal = proposal.claims.find((claim) => claim.verificationMode === 'formal_kernel');
  const empiricalClaims = empiricalMaterialization.declarations.flatMap((declaration, index) => [
    `\\section{${index === 0 ? 'Preregistered hypothesis' : 'Experimental setup'}}`,
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
    empiricalMaterialization.manuscriptClaimText,
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ]);
  return [
    '\\documentclass[11pt]{article}',
    '\\usepackage{amsmath,amssymb,amsthm}',
    '\\newtheorem{theorem}{Theorem}',
    '\\title{Autonomous bounded research report}',
    '\\author{}',
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    ...empiricalClaims,
    '\\section{Formal protocol invariant}',
    '\\begin{theorem}',
    latexEscape(formal.statement),
    '\\end{theorem}',
    '\\begin{proof}',
    AUTONOMOUS_FORMAL_MANUSCRIPT_PROOF,
    '\\end{proof}',
    '\\section{Limitations}',
    'This report is limited to the registered typed assertions and kernel-verified formal theorem.',
    '\\end{document}',
    '',
  ].join('\n');
}

export function materializeAutonomousResearchWorkspace({
  repository,
  loopPreparation,
  datasetMounts = [],
} = {}) {
  const proposal = loopPreparation?.proposal;
  const policyAuthorization = loopPreparation?.policyAuthorization;
  const seedBundle = loopPreparation?.seedBundle;
  const seedBinding = loopPreparation?.seedBinding;
  const proposalVerification = verifyMachineProposedScientificClaimSet(proposal);
  const policyVerification = verifyAutonomousResearchPolicyAuthorization(policyAuthorization, { proposal });
  if (loopPreparation?.autonomousExecutionLaunchReady !== true
    || !proposalVerification.valid || !policyVerification.valid
    || seedBundle?.status !== 'autonomous_research_seed_contracts_ready'
    || seedBinding?.status !== 'autonomous_research_seed_bound'
    || seedBinding?.seedBundleHash !== seedBundle?.autonomousResearchSeedContractBundleHash
    || seedBinding?.contractPath !== 'AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json') {
    throw new Error('autonomous_research_workspace_materialization_not_authorized');
  }
  if (!verifyAutonomousEmpiricalExecutionProfileSelection(
    loopPreparation?.empiricalExecutionProfileSelection,
    {
      protocolFamily: proposal?.protocolFamily,
      requireReady: true,
      runtimeCapabilityInspection: loopPreparation?.empiricalRuntimeCapabilityInspection,
      requireRuntimeCapabilityInspection: true,
    },
  )) {
    throw new Error('autonomous_research_workspace_empirical_execution_profile_invalid');
  }
  if (repository?.kind !== 'AutonomousResearchWorkspaceRepository') {
    throw new Error('autonomous_research_workspace_repository_required');
  }
  if (!Array.isArray(datasetMounts) || datasetMounts.length !== 1
    || datasetMounts[0]?.benchmarkFamily !== proposal.protocolFamily) {
    throw new Error('autonomous_research_workspace_dataset_authority_required');
  }
  const templateSelector = buildCampaignBenchmarkSelector({
    benchmarkId: datasetMounts[0].name,
    datasetMounts,
  });
  const analysisProtocolTemplate = Object.freeze({
    ...templateSelector.experimentDesign.analysisProtocol,
    analysisProtocolHash: templateSelector.experimentDesign.analysisProtocolHash,
  });
  const empiricalMaterialization = deriveAutonomousEmpiricalClaimMaterialization({
    proposal,
    seedBundle,
    analysisProtocolTemplate,
  });
  const sourceWorkspace = repository.sourceWorkspace;
  const records = {
    autonomousSeedContracts: repository.writeJsonOnce(seedBinding.contractPath, seedBundle),
    autonomousProposal: repository.writeJsonOnce('AUTONOMOUS_RESEARCH_PROPOSAL.json', proposal),
    autonomousPolicy: repository.writeJsonOnce(
      'AUTONOMOUS_RESEARCH_POLICY_AUTHORIZATION.json',
      policyAuthorization,
    ),
    hypothesisGenerationReceipt: repository.writeJsonOnce(
      'AUTONOMOUS_HYPOTHESIS_GENERATION_RECEIPT.json',
      loopPreparation.generationReceipt,
    ),
    mainTex: repository.writeTextOnce('main.tex', manuscriptSkeleton({
      proposal,
      empiricalMaterialization,
    })),
    readme: repository.writeTextOnce('README.md', [
      '# Autonomous research source',
      '',
      'Machine-proposed, system-policy-authorized bounded research workspace.',
      'No operator approval, external qualification, or universal validity is represented here.',
      '',
    ].join('\n')),
  };
  const empiricalClaimUniverse = readEmpiricalClaimUniverse({ sourceRoot: sourceWorkspace });
  const empiricalClaimLineage = createAutonomousEmpiricalClaimLineage({
    proposal,
    seedBundle,
    analysisProtocolTemplate,
    empiricalClaimUniverse,
  });
  records.autonomousEmpiricalClaimLineage = repository.writeJsonOnce(
    'AUTONOMOUS_EMPIRICAL_CLAIM_LINEAGE.json',
    empiricalClaimLineage,
  );
  const payload = {
    version: 2,
    kind: 'AutonomousResearchWorkspaceMaterializationReceipt',
    status: 'autonomous_research_workspace_materialized',
    paperId: proposal.paperId,
    sourceWorkspace,
    mainTex: path.join(sourceWorkspace, 'main.tex'),
    scientificClaimAuthority: seedBinding,
    analysisProtocolTemplateHash: analysisProtocolTemplate.analysisProtocolHash,
    empiricalExecutionProfileSelectionHash:
      loopPreparation.empiricalExecutionProfileSelection
        .autonomousEmpiricalExecutionProfileSelectionHash,
    empiricalRuntimeCapabilityInspectionHash:
      loopPreparation.empiricalExecutionProfileSelection.runtimeCapabilityInspectionHash,
    autonomousEmpiricalExecutionProfilePolicyHash:
      loopPreparation.empiricalExecutionProfileSelection.policyHash,
    empiricalClaimUniverse,
    empiricalClaimLineage,
    records: Object.freeze(records),
    sourceMutationOutsideWorkspace: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchWorkspaceMaterializationReceiptHash:
      hashRecord('AutonomousResearchWorkspaceMaterializationReceipt', payload),
  });
}
