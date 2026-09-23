import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyResearchAgendaIr } from './research-agenda-ir.mjs';
import {
  verifyMachineProposedScientificClaimSet,
} from './autonomous-research-proposal-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_KEYS = Object.freeze([
  'agendaSelectionReceiptHash', 'bindingMode', 'blockers',
  'dynamicFormalClaimSeedHash', 'empiricalClaimKey', 'empiricalClaimRecordHash',
  'externalActionPerformed', 'formalClaimKey', 'formalClaimRecordHash',
  'formalTargetsHash', 'humanApprovalPerformed', 'kind', 'paperId',
  'primaryClaimTextHash', 'proposalHash', 'researchAgendaClaimBindingReceiptHash',
  'researchAgendaIrHash', 'status', 'version',
]);

function claimHash(claim) {
  return claim ? hashRecord('AutonomousResearchClaimRecord', claim) : null;
}

function agendaLineageValid(researchAgendaIr, proposal) {
  const selection = proposal?.agendaSelectionReceipt || null;
  const productionReceipt = selection?.researchAgendaProducerReceipt || null;
  return selection?.version === 2
    && verifyResearchAgendaIr(researchAgendaIr, {
      agendaProductionReceipt: productionReceipt,
    })
    && researchAgendaIr.paperId === proposal?.paperId
    && researchAgendaIr.protocolFamily === proposal?.protocolFamily
    && researchAgendaIr.sourceAgendaProductionReceiptHash
      === productionReceipt?.autonomousResearchAgendaProductionReceiptHash
    && proposal?.agendaSelectionReceiptHash
      === selection?.autonomousResearchAgendaSelectionReceiptHash;
}

export function buildResearchAgendaClaimBindingReceipt({
  researchAgendaIr,
  proposal,
} = {}) {
  const blockers = [];
  const proposalVerification = verifyMachineProposedScientificClaimSet(proposal);
  if (!proposalVerification.valid) {
    blockers.push('research_agenda_claim_binding_proposal_invalid');
  }
  if (!agendaLineageValid(researchAgendaIr, proposal)) {
    blockers.push('research_agenda_claim_binding_agenda_lineage_invalid');
  }
  const empiricalClaims = (proposal?.claims || []).filter((claim) => (
    claim?.verificationMode === 'empirical_protocol'
  ));
  const formalClaims = (proposal?.claims || []).filter((claim) => (
    claim?.verificationMode === 'formal_kernel'
  ));
  const empiricalClaim = empiricalClaims.length === 1 ? empiricalClaims[0] : null;
  const formalClaim = formalClaims.length === 1 ? formalClaims[0] : null;
  if (!empiricalClaim) blockers.push('research_agenda_claim_binding_empirical_claim_cardinality_invalid');
  if (!formalClaim) blockers.push('research_agenda_claim_binding_formal_claim_cardinality_invalid');
  if (empiricalClaim && researchAgendaIr?.primaryClaim !== empiricalClaim.statement) {
    blockers.push('research_agenda_claim_binding_primary_claim_mismatch');
  }
  if (!Array.isArray(researchAgendaIr?.formalTargets)
    || researchAgendaIr.formalTargets.length !== 1) {
    blockers.push('research_agenda_claim_binding_formal_target_cardinality_invalid');
  } else if (formalClaim && researchAgendaIr.formalTargets[0] !== formalClaim.statement) {
    blockers.push('research_agenda_claim_binding_formal_target_mismatch');
  }
  if (proposal?.dynamicFormalClaimSeed
    && formalClaim?.statement !== proposal.dynamicFormalClaimSeed.statement) {
    blockers.push('research_agenda_claim_binding_dynamic_formal_seed_mismatch');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'ResearchAgendaClaimBindingReceipt',
    status: uniqueBlockers.length
      ? 'research_agenda_claim_binding_blocked'
      : 'research_agenda_claim_binding_verified',
    bindingMode: 'exact-normalized-agenda-claim-text-v1',
    paperId: researchAgendaIr?.paperId || proposal?.paperId || null,
    researchAgendaIrHash: researchAgendaIr?.researchAgendaIrHash || null,
    agendaSelectionReceiptHash: proposal?.agendaSelectionReceiptHash || null,
    proposalHash: proposal?.machineProposedScientificClaimSetHash || null,
    primaryClaimTextHash: researchAgendaIr?.primaryClaim
      ? hashRecord('ResearchAgendaPrimaryClaimText', {
        text: researchAgendaIr.primaryClaim,
      }) : null,
    empiricalClaimKey: empiricalClaim?.claimKey || null,
    empiricalClaimRecordHash: claimHash(empiricalClaim),
    formalTargetsHash: Array.isArray(researchAgendaIr?.formalTargets)
      ? hashRecord('ResearchAgendaFormalTargets', researchAgendaIr.formalTargets) : null,
    formalClaimKey: formalClaim?.claimKey || null,
    formalClaimRecordHash: claimHash(formalClaim),
    dynamicFormalClaimSeedHash:
      proposal?.dynamicFormalClaimSeed?.dynamicFormalClaimSeedHash || null,
    humanApprovalPerformed: false,
    externalActionPerformed: false,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    researchAgendaClaimBindingReceiptHash:
      hashRecord('ResearchAgendaClaimBindingReceipt', payload),
  });
}

export function verifyResearchAgendaClaimBindingReceipt(receipt, {
  researchAgendaIr,
  proposal,
} = {}) {
  const blockers = [];
  const { researchAgendaClaimBindingReceiptHash: claimedHash, ...payload } = receipt || {};
  if (!hasExactObjectKeys(receipt, RECEIPT_KEYS)
    || receipt?.version !== 1
    || receipt?.kind !== 'ResearchAgendaClaimBindingReceipt'
    || receipt?.bindingMode !== 'exact-normalized-agenda-claim-text-v1'
    || receipt?.humanApprovalPerformed !== false
    || receipt?.externalActionPerformed !== false
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('ResearchAgendaClaimBindingReceipt', payload) !== claimedHash) {
    blockers.push('research_agenda_claim_binding_receipt_invalid');
  }
  let rebuilt = null;
  try {
    rebuilt = buildResearchAgendaClaimBindingReceipt({ researchAgendaIr, proposal });
  } catch {
    blockers.push('research_agenda_claim_binding_rebuild_failed');
  }
  if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(receipt)) {
    blockers.push('research_agenda_claim_binding_not_canonical');
  }
  if (receipt?.status !== 'research_agenda_claim_binding_verified'
    || receipt?.blockers?.length !== 0) {
    blockers.push(...(receipt?.blockers || ['research_agenda_claim_binding_not_verified']));
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'research_agenda_claim_binding_verification_blocked'
      : 'research_agenda_claim_binding_verification_verified',
    researchAgendaClaimBindingReceiptHash: claimedHash || null,
    blockers: uniqueBlockers,
  });
}
