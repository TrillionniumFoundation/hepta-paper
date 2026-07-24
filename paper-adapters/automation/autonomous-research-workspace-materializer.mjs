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
import {
  verifyPriorArtEvidenceReceipt,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import {
  buildDefaultAutonomousManuscriptIrDraft,
} from './autonomous-manuscript-ir-materialization.mjs';
import {
  verifyAutonomousVenueProfileSelection,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  verifyAutonomousSubmissionMetadataReceipt,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  verifyResearchAgendaClaimBindingReceipt,
} from '../../paper-domain/automation/research-agenda-claim-binding-contract.mjs';
import { verifyVenueRequirementIr } from '../../paper-domain/automation/venue-requirement-ir.mjs';
import {
  verifyAutonomousVenueTemplateAssetRecord,
} from '../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';

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
  const priorArtReceipt = loopPreparation?.priorArtReceipt;
  const researchAgendaIr = loopPreparation?.researchAgendaIr || null;
  const agendaClaimBindingReceipt = loopPreparation?.agendaClaimBindingReceipt || null;
  const venueProfileSelection = loopPreparation?.venueProfileSelection || null;
  const venueRequirementIr = loopPreparation?.venueRequirementIr || null;
  const venueTemplateAsset = loopPreparation?.venueTemplateAsset || null;
  const venueTemplateAssetBundleHash =
    loopPreparation?.venueTemplateAssetBundleHash || null;
  const venueTemplateAssetAuthorityConfigurationHash =
    loopPreparation?.venueTemplateAssetAuthorityConfigurationHash || null;
  const submissionMetadataReceipt = loopPreparation?.submissionMetadataReceipt || null;
  const proposalVerification = verifyMachineProposedScientificClaimSet(proposal);
  const policyVerification = verifyAutonomousResearchPolicyAuthorization(policyAuthorization, { proposal });
  const priorArtVerification = verifyPriorArtEvidenceReceipt(priorArtReceipt, {
    paperId: proposal?.paperId,
    agendaSelectionReceiptHash:
      proposal?.agendaSelectionReceipt?.autonomousResearchAgendaSelectionReceiptHash,
  });
  const agendaClaimBindingVerification = researchAgendaIr
    ? verifyResearchAgendaClaimBindingReceipt(agendaClaimBindingReceipt, {
      researchAgendaIr,
      proposal,
    }) : Object.freeze({ valid: agendaClaimBindingReceipt === null });
  const venueRequirementIrRequired = venueProfileSelection?.profile?.version === 3;
  const venueRequirementIrValid = venueRequirementIrRequired
    ? Boolean(researchAgendaIr && verifyVenueRequirementIr(venueRequirementIr, {
      researchAgendaIr,
      venueProfile: venueProfileSelection.profile,
      venueProfileSelection,
      expectedVenueProfileRegistryHash: venueProfileSelection.registryHash || null,
      expectedVenueAuthorityConfigurationHash:
        venueProfileSelection.venueAuthorityConfigurationHash || null,
    }))
    : venueRequirementIr === null;
  const venueTemplateAssetValid = venueRequirementIrRequired ? (
    verifyAutonomousVenueTemplateAssetRecord(venueTemplateAsset)
    && JSON.stringify(venueTemplateAsset)
      === JSON.stringify(venueProfileSelection?.venueTemplateAsset)
    && venueTemplateAsset.venueId === venueProfileSelection.venueId
    && venueTemplateAsset.templateAssetHash === venueRequirementIr?.templateAssetHash
    && venueTemplateAssetBundleHash
      === venueProfileSelection?.venueTemplateAssetBundleHash
    && venueTemplateAssetBundleHash
      === venueProfileSelection?.rankingReceipt?.venueTemplateAssetBundleHash
    && venueTemplateAssetBundleHash
      === venueProfileSelection?.registryAuthorityProof?.subjectHash
    && venueTemplateAssetAuthorityConfigurationHash
      === venueProfileSelection?.venueAuthorityConfigurationHash
    && venueTemplateAssetAuthorityConfigurationHash
      === venueProfileSelection?.registryAuthorityProof?.configurationHash
    && venueProfileSelection?.registryAuthorityProof?.subjectKind
      === 'AutonomousVenueTemplateAssetBundle'
  ) : venueTemplateAsset === null
    && venueTemplateAssetBundleHash === null
    && venueTemplateAssetAuthorityConfigurationHash === null;
  if (loopPreparation?.autonomousExecutionLaunchReady !== true
    || !proposalVerification.valid || !policyVerification.valid
    || !priorArtVerification.valid
    || !agendaClaimBindingVerification.valid
    || !venueRequirementIrValid
    || !venueTemplateAssetValid
    || (venueProfileSelection && !verifyAutonomousVenueProfileSelection(
      venueProfileSelection,
      { authorityObservedAt: loopPreparation?.createdAt },
    ))
    || (submissionMetadataReceipt && !verifyAutonomousSubmissionMetadataReceipt(
      submissionMetadataReceipt,
      {
        paperId: proposal?.paperId,
        protocolFamily: proposal?.protocolFamily,
        authorityObservedAt: loopPreparation?.createdAt,
      },
    ))
    || (venueProfileSelection?.profile?.externalSubmissionEnabled === true
      && !submissionMetadataReceipt)
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
      runtimeReproducibilityInspection:
        loopPreparation?.runtimeImageReproducibilityInspection,
      requireRegisteredRuntime: loopPreparation?.launchMode === 'production-run',
      observedAt: loopPreparation?.createdAt,
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
    priorArtEvidence: repository.writeJsonOnce(
      'AUTONOMOUS_PRIOR_ART_EVIDENCE.json',
      priorArtReceipt,
    ),
    ...(researchAgendaIr ? {
      researchAgendaIr: repository.writeJsonOnce(
        'AUTONOMOUS_RESEARCH_AGENDA_IR.json',
        researchAgendaIr,
      ),
      agendaClaimBinding: repository.writeJsonOnce(
        'AUTONOMOUS_RESEARCH_AGENDA_CLAIM_BINDING.json',
        agendaClaimBindingReceipt,
      ),
    } : {}),
    ...(venueProfileSelection ? {
      venueProfileSelection: repository.writeJsonOnce(
        'AUTONOMOUS_VENUE_PROFILE_SELECTION.json',
        venueProfileSelection,
      ),
    } : {}),
    ...(venueRequirementIr ? {
      venueRequirementIr: repository.writeJsonOnce(
        'AUTONOMOUS_VENUE_REQUIREMENT_IR.json',
        venueRequirementIr,
      ),
      venueTemplateAsset: repository.writeVenueTemplateAssetOnce(
        venueTemplateAsset,
      ),
    } : {}),
    ...(submissionMetadataReceipt ? {
      submissionMetadata: repository.writeJsonOnce(
        'AUTONOMOUS_SUBMISSION_METADATA.json',
        submissionMetadataReceipt,
      ),
    } : {}),
    manuscriptIrDraft: repository.writeJsonOnce(
      'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
      buildDefaultAutonomousManuscriptIrDraft({
        proposal,
        policyAuthorization,
        seedBundle,
        priorArtReceipt,
      }),
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
    version: venueRequirementIr ? 3 : 2,
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
    ...(agendaClaimBindingReceipt ? {
      researchAgendaIrHash: researchAgendaIr.researchAgendaIrHash,
      researchAgendaClaimBindingReceiptHash:
        agendaClaimBindingReceipt.researchAgendaClaimBindingReceiptHash,
    } : {}),
    ...(venueProfileSelection ? {
      venueProfileSelectionHash:
        venueProfileSelection.autonomousVenueProfileSelectionReceiptHash,
    } : {}),
    ...(venueRequirementIr ? {
      venueRequirementIrHash: venueRequirementIr.venueRequirementIrHash,
      venueTemplateAssetHash: venueTemplateAsset.templateAssetHash,
      venueTemplateAssetApplicationMode: venueTemplateAsset.applicationMode,
      venueTemplateAssetPath: venueTemplateAsset.relativePath,
      venueTemplateAssetFileHash: records.venueTemplateAsset,
      venueTemplateAssetBundleHash,
      venueTemplateAssetAuthorityConfigurationHash,
    } : {}),
    ...(submissionMetadataReceipt ? {
      submissionMetadataReceiptHash:
        submissionMetadataReceipt.autonomousSubmissionMetadataReceiptHash,
    } : {}),
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
