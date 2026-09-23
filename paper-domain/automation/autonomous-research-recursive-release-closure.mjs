import { verifyResearchAgendaIr } from './research-agenda-ir.mjs';
import {
  verifyResearchAgendaClaimBindingReceipt,
} from './research-agenda-claim-binding-contract.mjs';
import {
  verifyPriorArtClaimAlignmentReceipt,
} from '../research/prior-art-claim-alignment-contract.mjs';
import { verifyVenueRequirementIr } from './venue-requirement-ir.mjs';
import {
  verifyExperimentIrExecutionAuthorityReceipt,
} from './experiment-ir-execution-authority-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function validHash(value) {
  return SHA256.test(String(value || ''));
}

export function inspectAutonomousResearchRecursiveReleaseSource({
  campaignId,
  paperId,
  campaignPlanHash,
  preparation,
  agendaReceipt,
  priorArtEvidenceReceipt,
  venueProfileSelection,
  venueProfileValid,
  externalSubmissionRequested,
  researchReport,
  experimentIrExecutionAuthorityReceipt,
  experimentReplayReceipt,
} = {}) {
  const researchAgendaIr = preparation?.researchAgendaIr || null;
  const agendaClaimBindingReceipt = preparation?.agendaClaimBindingReceipt || null;
  const priorArtClaimAlignmentReceipt = preparation?.priorArtClaimAlignmentReceipt || null;
  const venueRequirementIr = preparation?.venueRequirementIr || null;
  const researchAgendaIrReady = verifyResearchAgendaIr(researchAgendaIr, {
    agendaProductionReceipt: agendaReceipt,
  });
  const agendaClaimBindingReady = researchAgendaIrReady
    && verifyResearchAgendaClaimBindingReceipt(agendaClaimBindingReceipt, {
      researchAgendaIr,
      proposal: preparation?.proposal,
    }).valid;
  const priorArtClaimAlignmentReady = agendaClaimBindingReady
    && verifyPriorArtClaimAlignmentReceipt(priorArtClaimAlignmentReceipt, {
      researchAgendaIr,
      priorArtEvidenceReceipt,
      agendaSelectionReceiptHash: preparation?.proposal?.agendaSelectionReceiptHash,
    });
  const venueRequirementIrReady = venueProfileValid
    && researchAgendaIrReady
    && verifyVenueRequirementIr(venueRequirementIr, {
      researchAgendaIr,
      venueProfile: venueProfileSelection?.profile || null,
      venueProfileSelection,
      expectedVenueProfileRegistryHash: venueProfileSelection?.registryHash || null,
      expectedVenueAuthorityConfigurationHash:
        venueProfileSelection?.venueAuthorityConfigurationHash || null,
    });
  const experimentExecutionAuthorityReady = Boolean(
    experimentIrExecutionAuthorityReceipt
    && experimentReplayReceipt
    && researchAgendaIrReady
    && agendaClaimBindingReady
    && verifyExperimentIrExecutionAuthorityReceipt(
      experimentIrExecutionAuthorityReceipt,
      {
        campaignId,
        paperId,
        campaignPlanHash,
        nodeId: experimentIrExecutionAuthorityReceipt.nodeId,
        nodeKind: experimentIrExecutionAuthorityReceipt.nodeKind,
        researchAgendaIr,
        researchAgendaProducerReceipt: agendaReceipt,
        proposal: preparation?.proposal,
        researchAgendaClaimBindingReceipt: agendaClaimBindingReceipt,
        experimentReplayReceipt,
      },
    )
  );
  const researchReportHash = researchReport?.researchReportHash || null;
  const proposalClaimToTheoremBindingHash =
    researchReport?.proposalClaimToTheoremBindingHash || null;
  const experimentRegistryHash = researchReport?.experimentRegistryHash || null;
  return Object.freeze({
    ready: externalSubmissionRequested === true
      && researchAgendaIrReady
      && agendaClaimBindingReady
      && priorArtClaimAlignmentReady
      && venueRequirementIrReady
      && experimentExecutionAuthorityReady
      && validHash(researchReportHash)
      && validHash(proposalClaimToTheoremBindingHash)
      && validHash(experimentRegistryHash),
    researchAgendaIr,
    agendaClaimBindingReceipt,
    priorArtClaimAlignmentReceipt,
    venueRequirementIr,
    researchAgendaIrReady,
    agendaClaimBindingReady,
    priorArtClaimAlignmentReady,
    venueRequirementIrReady,
    experimentExecutionAuthorityReady,
    experimentIrExecutionAuthorityReceipt,
    experimentReplayReceipt,
    researchReportHash,
    proposalClaimToTheoremBindingHash,
    experimentRegistryHash,
  });
}

export function autonomousResearchRecursiveReleaseBindingFields({
  source,
  proposal,
} = {}) {
  if (source?.ready !== true) return Object.freeze({});
  return Object.freeze({
    proposal,
    researchAgendaIrHash: source.researchAgendaIr.researchAgendaIrHash,
    researchAgendaIr: source.researchAgendaIr,
    researchAgendaClaimBindingReceiptHash:
      source.agendaClaimBindingReceipt.researchAgendaClaimBindingReceiptHash,
    researchAgendaClaimBindingReceipt: source.agendaClaimBindingReceipt,
    priorArtClaimAlignmentReceiptHash:
      source.priorArtClaimAlignmentReceipt.priorArtClaimAlignmentReceiptHash,
    priorArtClaimAlignmentReceipt: source.priorArtClaimAlignmentReceipt,
    venueRequirementIrHash: source.venueRequirementIr.venueRequirementIrHash,
    venueRequirementIr: source.venueRequirementIr,
    experimentIrExecutionAuthorityReceiptHash:
      source.experimentIrExecutionAuthorityReceipt
        .experimentIrExecutionAuthorityReceiptHash,
    experimentIrExecutionAuthorityReceipt:
      source.experimentIrExecutionAuthorityReceipt,
    experimentReplayReceiptHash:
      source.experimentReplayReceipt.experimentReplayReceiptHash,
    experimentReplayReceipt: source.experimentReplayReceipt,
    researchReportHash: source.researchReportHash,
    proposalClaimToTheoremBindingHash:
      source.proposalClaimToTheoremBindingHash,
    experimentRegistryHash: source.experimentRegistryHash,
  });
}

export function verifyAutonomousResearchRecursiveReleaseBinding(binding, {
  agendaReceipt = null,
} = {}) {
  if (binding?.version !== 4) return false;
  const researchAgendaIrReady = verifyResearchAgendaIr(binding?.researchAgendaIr, {
    agendaProductionReceipt: agendaReceipt,
  }) && binding?.researchAgendaIrHash === binding?.researchAgendaIr?.researchAgendaIrHash;
  const agendaClaimBindingReady = researchAgendaIrReady
    && verifyResearchAgendaClaimBindingReceipt(
      binding?.researchAgendaClaimBindingReceipt,
      { researchAgendaIr: binding.researchAgendaIr, proposal: binding?.proposal },
    ).valid
    && binding?.researchAgendaClaimBindingReceiptHash
      === binding?.researchAgendaClaimBindingReceipt
        ?.researchAgendaClaimBindingReceiptHash;
  const priorArtClaimAlignmentReady = agendaClaimBindingReady
    && verifyPriorArtClaimAlignmentReceipt(binding?.priorArtClaimAlignmentReceipt, {
      researchAgendaIr: binding.researchAgendaIr,
      priorArtEvidenceReceipt: binding?.priorArtEvidenceReceipt,
      agendaSelectionReceiptHash: binding?.proposal?.agendaSelectionReceiptHash,
    })
    && binding?.priorArtClaimAlignmentReceiptHash
      === binding?.priorArtClaimAlignmentReceipt?.priorArtClaimAlignmentReceiptHash;
  const venueRequirementIrReady = researchAgendaIrReady
    && verifyVenueRequirementIr(binding?.venueRequirementIr, {
      researchAgendaIr: binding.researchAgendaIr,
      venueProfile: binding?.venueProfileSelection?.profile || null,
      venueProfileSelection: binding?.venueProfileSelection || null,
      expectedVenueProfileRegistryHash:
        binding?.venueProfileSelection?.registryHash || null,
      expectedVenueAuthorityConfigurationHash:
        binding?.venueAuthorityConfigurationHash || null,
    })
    && binding?.venueRequirementIrHash
      === binding?.venueRequirementIr?.venueRequirementIrHash;
  const experimentExecutionAuthorityReady = agendaClaimBindingReady
    && verifyExperimentIrExecutionAuthorityReceipt(
      binding?.experimentIrExecutionAuthorityReceipt,
      {
        campaignId: binding?.campaignId,
        paperId: binding?.paperId,
        campaignPlanHash: binding?.campaignPlanHash,
        nodeId: binding?.experimentIrExecutionAuthorityReceipt?.nodeId,
        nodeKind: binding?.experimentIrExecutionAuthorityReceipt?.nodeKind,
        researchAgendaIr: binding?.researchAgendaIr,
        researchAgendaProducerReceipt: agendaReceipt,
        proposal: binding?.proposal,
        researchAgendaClaimBindingReceipt:
          binding?.researchAgendaClaimBindingReceipt,
        experimentReplayReceipt: binding?.experimentReplayReceipt,
      },
    )
    && binding?.experimentIrExecutionAuthorityReceiptHash
      === binding?.experimentIrExecutionAuthorityReceipt
        ?.experimentIrExecutionAuthorityReceiptHash
    && binding?.experimentReplayReceiptHash
      === binding?.experimentReplayReceipt?.experimentReplayReceiptHash;
  return researchAgendaIrReady
    && agendaClaimBindingReady
    && priorArtClaimAlignmentReady
    && venueRequirementIrReady
    && experimentExecutionAuthorityReady
    && validHash(binding?.researchReportHash)
    && validHash(binding?.proposalClaimToTheoremBindingHash)
    && validHash(binding?.experimentRegistryHash)
    && binding?.proposalHash === binding?.proposal?.machineProposedScientificClaimSetHash;
}
