import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  verifyResearchAgendaIr,
} from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  buildPriorArtClaimAlignmentReceipt,
  conservativePriorArtClaimAlignmentRecords,
  verifyPriorArtClaimAlignmentReceipt,
} from '../../paper-domain/research/prior-art-claim-alignment-contract.mjs';
import {
  verifyPriorArtEvidenceReceiptV2,
} from '../../paper-domain/research/prior-art-evidence-v2-contract.mjs';

function verifyAgendaSelectionLineage({ agendaSelectionReceipt, researchAgendaIr } = {}) {
  const {
    autonomousResearchAgendaSelectionReceiptHash: claimedHash,
    ...payload
  } = agendaSelectionReceipt || {};
  const productionReceipt = agendaSelectionReceipt?.researchAgendaProducerReceipt || null;
  return agendaSelectionReceipt?.version === 2
    && agendaSelectionReceipt?.kind === 'AutonomousResearchAgendaSelectionReceipt'
    && agendaSelectionReceipt?.status === 'autonomous_research_agenda_selected'
    && agendaSelectionReceipt?.agendaMode === 'machine-generated'
    && agendaSelectionReceipt?.scientificNoveltyVerified === false
    && hashRecord('AutonomousResearchAgendaSelectionReceipt', payload) === claimedHash
    && verifyAutonomousResearchAgendaProductionReceipt(productionReceipt).valid
    && verifyResearchAgendaIr(researchAgendaIr, {
      agendaProductionReceipt: productionReceipt,
    })
    && researchAgendaIr.paperId === agendaSelectionReceipt.paperId
    && researchAgendaIr.protocolFamily === agendaSelectionReceipt.selectedProtocolFamily
    && productionReceipt.autonomousResearchAgendaProductionReceiptHash
      === researchAgendaIr.sourceAgendaProductionReceiptHash;
}

export function buildConservativePriorArtClaimAlignment({
  researchAgendaIr,
  agendaSelectionReceipt,
  priorArtEvidenceReceipt,
} = {}) {
  if (!verifyAgendaSelectionLineage({ agendaSelectionReceipt, researchAgendaIr })) {
    throw new Error('prior_art_claim_alignment_agenda_lineage_invalid');
  }
  const agendaSelectionReceiptHash =
    agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash;
  const priorArtVerification = verifyPriorArtEvidenceReceiptV2(priorArtEvidenceReceipt, {
    paperId: researchAgendaIr.paperId,
    agendaSelectionReceiptHash,
    researchAgendaIrHash: researchAgendaIr.researchAgendaIrHash,
    priorArtQueryPlan: researchAgendaIr.priorArtQueryPlan,
    requireVerified: true,
  });
  if (!priorArtVerification.ready
    || priorArtEvidenceReceipt.openWorldCompletenessClaimed !== false
    || priorArtEvidenceReceipt.scientificNoveltyVerified !== false) {
    throw new Error('prior_art_claim_alignment_source_evidence_invalid');
  }
  const alignments = conservativePriorArtClaimAlignmentRecords({
    researchAgendaIr,
    priorArtEvidenceReceipt,
  });
  if (!alignments) {
    throw new Error('prior_art_claim_alignment_ranked_works_required');
  }
  const receipt = buildPriorArtClaimAlignmentReceipt({
    researchAgendaIr,
    priorArtEvidenceReceipt,
    agendaSelectionReceiptHash,
    alignments,
  });
  if (!verifyPriorArtClaimAlignmentReceipt(receipt, {
    researchAgendaIr,
    priorArtEvidenceReceipt,
    agendaSelectionReceiptHash,
  })) {
    throw new Error('prior_art_claim_alignment_projection_invalid');
  }
  return receipt;
}

export function verifyConservativePriorArtClaimAlignment(receipt, {
  researchAgendaIr,
  agendaSelectionReceipt,
  priorArtEvidenceReceipt,
} = {}) {
  let rebuilt = null;
  try {
    rebuilt = buildConservativePriorArtClaimAlignment({
      researchAgendaIr,
      agendaSelectionReceipt,
      priorArtEvidenceReceipt,
    });
  } catch { return false; }
  return JSON.stringify(rebuilt) === JSON.stringify(receipt);
}
