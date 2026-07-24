import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  normalizePriorArtQueryPlan,
  priorArtQueryPlanHash,
  verifyResearchAgendaIr,
} from '../automation/research-agenda-ir.mjs';
import {
  priorArtExecutedQueriesMatchPlanV2,
  verifyPriorArtEvidenceReceiptV2,
} from './prior-art-evidence-v2-contract.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_KEYS = Object.freeze([
  'agendaSelectionReceiptHash', 'alignments', 'alignmentMode', 'blockers', 'kind',
  'openWorldCompletenessClaimed', 'paperId', 'priorArtClaimAlignmentReceiptHash',
  'priorArtEvidenceReceiptHash', 'researchAgendaIrHash', 'scientificNoveltyVerified',
  'status', 'version',
]);
const GAP_BOUNDARY = [
  'The listed records are only the top-ranked results from the verified finite retrieval.',
  'This projection does not establish a semantic research gap, scientific novelty,',
  'or open-world completeness.',
].join(' ');

function id(value) {
  const selected = String(value || '').trim();
  return ID.test(selected) ? selected : null;
}

function text(value) {
  const selected = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return selected && selected.length <= 4_000 ? selected : null;
}

function ids(values) {
  if (!Array.isArray(values) || !values.length || values.length > 256) return null;
  const selected = values.map(id);
  if (selected.some((value) => !value) || new Set(selected).size !== selected.length) return null;
  return Object.freeze([...selected].sort());
}

function alignment(value, { queryIds, workIds } = {}) {
  const payload = {
    claimId: id(value?.claimId),
    claimText: text(value?.claimText),
    queryIds: ids(value?.queryIds),
    closestWorkIds: ids(value?.closestWorkIds),
    contradictoryWorkIds: Array.isArray(value?.contradictoryWorkIds)
      && value.contradictoryWorkIds.length === 0
      ? Object.freeze([]) : ids(value?.contradictoryWorkIds),
    closestWorkGap: text(value?.closestWorkGap),
    limitations: text(value?.limitations),
  };
  const allQueriesKnown = payload.queryIds?.every((item) => queryIds.has(item));
  const allWorksKnown = [...(payload.closestWorkIds || []),
    ...(payload.contradictoryWorkIds || [])].every((item) => workIds.has(item));
  return Object.values(payload).every((item) => item !== null)
    && allQueriesKnown && allWorksKnown ? Object.freeze(payload) : null;
}

export function conservativePriorArtClaimAlignmentRecords({
  researchAgendaIr,
  priorArtEvidenceReceipt,
} = {}) {
  const queryIds = (priorArtEvidenceReceipt?.queries || [])
    .map((query) => query.queryId).sort();
  const closestWorkIds = [...new Set(
    (priorArtEvidenceReceipt?.rankingReceipts || [])
      .map((ranking) => ranking?.entries?.[0]?.workId || null),
  )].sort();
  if (!queryIds.length || closestWorkIds.some((workId) => !workId)
    || closestWorkIds.length === 0) return null;
  return Object.freeze([Object.freeze({
    claimId: 'primary-claim',
    claimText: researchAgendaIr?.primaryClaim || null,
    queryIds: Object.freeze(queryIds),
    closestWorkIds: Object.freeze(closestWorkIds),
    contradictoryWorkIds: Object.freeze([]),
    closestWorkGap: GAP_BOUNDARY,
    limitations: [
      'Open-world completeness and scientific novelty are not claimed.',
      `All source coverage limitations remain binding through ${priorArtEvidenceReceipt?.priorArtEvidenceReceiptHash || '<missing>'}.`,
    ].join(' '),
  })]);
}

export function buildPriorArtClaimAlignmentReceipt({
  researchAgendaIr,
  priorArtEvidenceReceipt,
  agendaSelectionReceiptHash = priorArtEvidenceReceipt?.agendaSelectionReceiptHash,
  alignments,
} = {}) {
  const agendaValid = verifyResearchAgendaIr(researchAgendaIr);
  const selectionHash = String(agendaSelectionReceiptHash || '').toLowerCase();
  const normalizedQueryPlan = normalizePriorArtQueryPlan(
    researchAgendaIr?.priorArtQueryPlan,
  );
  const expectedQueryPlanHash = priorArtQueryPlanHash(normalizedQueryPlan);
  const priorArtVerification = verifyPriorArtEvidenceReceiptV2(priorArtEvidenceReceipt, {
    paperId: researchAgendaIr?.paperId,
    agendaSelectionReceiptHash: selectionHash,
    researchAgendaIrHash: researchAgendaIr?.researchAgendaIrHash,
    priorArtQueryPlan: normalizedQueryPlan,
    priorArtQueryPlanHash: expectedQueryPlanHash,
    requireVerified: true,
  });
  const queryIds = new Set((priorArtEvidenceReceipt?.queries || []).map((item) => item.queryId));
  const workIds = new Set((priorArtEvidenceReceipt?.works || []).map((item) => item.workId));
  const selected = Array.isArray(alignments) && alignments.length <= 64
    ? alignments.map((item) => alignment(item, { queryIds, workIds })) : [];
  const blockers = [];
  if (!agendaValid) blockers.push('prior_art_claim_alignment_research_agenda_ir_invalid');
  if (priorArtEvidenceReceipt?.researchAgendaIrHash
    !== researchAgendaIr?.researchAgendaIrHash) {
    blockers.push('prior_art_claim_alignment_cross_agenda_forbidden');
  }
  if (!normalizedQueryPlan || !expectedQueryPlanHash
    || priorArtEvidenceReceipt?.priorArtQueryPlanHash !== expectedQueryPlanHash
    || JSON.stringify(priorArtEvidenceReceipt?.priorArtQueryPlan)
      !== JSON.stringify(normalizedQueryPlan)) {
    blockers.push('prior_art_claim_alignment_query_plan_binding_invalid');
  }
  if (!priorArtExecutedQueriesMatchPlanV2(
    priorArtEvidenceReceipt?.queries, normalizedQueryPlan,
  )) {
    blockers.push('prior_art_claim_alignment_executed_query_bijection_invalid');
  }
  if (!SHA256.test(selectionHash)) {
    blockers.push('prior_art_claim_alignment_agenda_selection_binding_invalid');
  }
  if (!priorArtVerification.ready) blockers.push('prior_art_claim_alignment_evidence_invalid');
  if (priorArtEvidenceReceipt?.openWorldCompletenessClaimed !== false
    || priorArtEvidenceReceipt?.scientificNoveltyVerified !== false) {
    blockers.push('prior_art_claim_alignment_open_world_boundary_invalid');
  }
  if (!selected.length || selected.some((item) => !item)) {
    blockers.push('prior_art_claim_alignment_records_invalid');
  }
  const validAlignments = selected.filter(Boolean)
    .sort((left, right) => left.claimId.localeCompare(right.claimId));
  if (new Set(validAlignments.map((item) => item.claimId)).size !== validAlignments.length) {
    blockers.push('prior_art_claim_alignment_claim_ids_duplicate');
  }
  if (validAlignments.length !== 1
    || validAlignments[0]?.claimText !== researchAgendaIr?.primaryClaim) {
    blockers.push('prior_art_claim_alignment_primary_claim_coverage_required');
  }
  const conservativeProjection = conservativePriorArtClaimAlignmentRecords({
    researchAgendaIr,
    priorArtEvidenceReceipt,
  });
  if (!conservativeProjection
    || JSON.stringify(validAlignments) !== JSON.stringify(conservativeProjection)) {
    blockers.push('prior_art_claim_alignment_conservative_projection_required');
  }
  const coveredQueries = new Set(validAlignments.flatMap((item) => item.queryIds));
  if ([...queryIds].some((queryId) => !coveredQueries.has(queryId))) {
    blockers.push('prior_art_claim_alignment_query_coverage_incomplete');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 2,
    kind: 'PriorArtClaimAlignmentReceipt',
    alignmentMode: 'finite-ranked-source-projection-v1',
    status: uniqueBlockers.length
      ? 'prior_art_claim_alignment_blocked' : 'prior_art_claim_alignment_verified',
    paperId: researchAgendaIr?.paperId || null,
    researchAgendaIrHash: researchAgendaIr?.researchAgendaIrHash || null,
    agendaSelectionReceiptHash: SHA256.test(selectionHash) ? selectionHash : null,
    priorArtEvidenceReceiptHash: priorArtEvidenceReceipt?.priorArtEvidenceReceiptHash || null,
    alignments: Object.freeze(validAlignments),
    openWorldCompletenessClaimed: false,
    scientificNoveltyVerified: false,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    priorArtClaimAlignmentReceiptHash:
      hashRecord('PriorArtClaimAlignmentReceipt', payload),
  });
}

export function verifyPriorArtClaimAlignmentReceipt(receipt, {
  researchAgendaIr,
  priorArtEvidenceReceipt,
  agendaSelectionReceiptHash = receipt?.agendaSelectionReceiptHash,
} = {}) {
  if (!hasExactObjectKeys(receipt, RECEIPT_KEYS)
    || receipt?.version !== 2
    || receipt?.alignmentMode !== 'finite-ranked-source-projection-v1'
    || receipt?.openWorldCompletenessClaimed !== false
    || receipt?.scientificNoveltyVerified !== false) return false;
  let rebuilt = null;
  try {
    rebuilt = buildPriorArtClaimAlignmentReceipt({
      researchAgendaIr,
      priorArtEvidenceReceipt,
      agendaSelectionReceiptHash,
      alignments: receipt.alignments,
    });
  } catch { return false; }
  return receipt.status === 'prior_art_claim_alignment_verified'
    && receipt.blockers.length === 0
    && JSON.stringify(rebuilt) === JSON.stringify(receipt);
}
