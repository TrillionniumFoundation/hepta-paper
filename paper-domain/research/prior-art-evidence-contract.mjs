import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  priorArtEvidenceHashesV2,
  verifyPriorArtEvidenceReceiptV2,
} from './prior-art-evidence-v2-contract.mjs';

export {
  buildPriorArtEvidenceReceiptV2,
  normalizePriorArtArxiv,
  normalizePriorArtDoi,
  normalizePriorArtOpenAlex,
  priorArtExecutedQueriesMatchPlanV2,
  priorArtEvidenceHashesV2,
  verifyPriorArtEvidenceReceiptV2,
} from './prior-art-evidence-v2-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const QUERY_KEYS = Object.freeze([
  'corpusSnapshotHash', 'executedAt', 'providers', 'query', 'queryId',
  'resultSetHash', 'retrievalReceiptHash',
]);
const WORK_KEYS = Object.freeze([
  'abstractHash', 'authors', 'identifiers', 'queryIds', 'sourceSnapshotHash',
  'title', 'workId', 'year',
]);
const IDENTIFIER_KEYS = Object.freeze(['arxiv', 'doi', 'openAlex', 'url']);
const REVIEW_KEYS = Object.freeze([
  'independentFromGenerator', 'principalId', 'providerAccountIdentityHash',
  'reviewReceiptHash', 'signatureVerificationReceiptHash', 'trustDomainIdentityHash',
]);

function normalizedText(value, maximum = 8_000) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text && text.length <= maximum ? text : null;
}

function canonicalId(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function canonicalHash(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function canonicalInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  const instant = String(value);
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === instant ? instant : null;
}

function uniqueText(values, maximumItems, maximumLength = 2_000) {
  if (!Array.isArray(values) || values.length > maximumItems) return null;
  const normalized = values.map((value) => normalizedText(value, maximumLength));
  if (normalized.some((value) => !value) || new Set(normalized).size !== normalized.length) return null;
  return Object.freeze(normalized);
}

function canonicalQuery(value) {
  if (!hasExactObjectKeys(value, QUERY_KEYS)) return null;
  const queryId = canonicalId(value.queryId);
  const query = normalizedText(value.query, 4_000);
  const providers = uniqueText(value.providers, 16, 200);
  const executedAt = canonicalInstant(value.executedAt);
  const corpusSnapshotHash = canonicalHash(value.corpusSnapshotHash);
  const resultSetHash = canonicalHash(value.resultSetHash);
  const retrievalReceiptHash = canonicalHash(value.retrievalReceiptHash);
  if (!queryId || !query || !providers?.length || !executedAt || !corpusSnapshotHash
    || !resultSetHash || !retrievalReceiptHash) return null;
  return Object.freeze({
    queryId,
    query,
    providers,
    executedAt,
    corpusSnapshotHash,
    resultSetHash,
    retrievalReceiptHash,
  });
}

function canonicalIdentifiers(value) {
  if (!hasExactObjectKeys(value, IDENTIFIER_KEYS)) return null;
  const identifiers = Object.freeze({
    doi: normalizedText(value.doi, 512),
    arxiv: normalizedText(value.arxiv, 512),
    openAlex: normalizedText(value.openAlex, 512),
    url: normalizedText(value.url, 2_000),
  });
  return Object.values(identifiers).some(Boolean) ? identifiers : null;
}

function canonicalWork(value, queryIds) {
  if (!hasExactObjectKeys(value, WORK_KEYS)) return null;
  const workId = canonicalId(value.workId);
  const title = normalizedText(value.title, 4_000);
  const authors = uniqueText(value.authors, 128, 500);
  const identifiers = canonicalIdentifiers(value.identifiers);
  const selectedQueries = uniqueText(value.queryIds, 64, 192);
  const year = value.year === null ? null : Number(value.year);
  const sourceSnapshotHash = canonicalHash(value.sourceSnapshotHash);
  const abstractHash = value.abstractHash === null ? null : canonicalHash(value.abstractHash);
  if (!workId || !title || !authors?.length || !identifiers || !selectedQueries?.length
    || selectedQueries.some((queryId) => !queryIds.has(queryId))
    || (year !== null && (!Number.isInteger(year) || year < 1000 || year > 3000))
    || !sourceSnapshotHash || (value.abstractHash !== null && !abstractHash)) return null;
  return Object.freeze({
    workId,
    title,
    authors,
    year,
    identifiers,
    queryIds: selectedQueries,
    sourceSnapshotHash,
    abstractHash,
  });
}

function canonicalReview(value, generatorPrincipalId) {
  if (value === null || value === undefined) return null;
  if (!hasExactObjectKeys(value, REVIEW_KEYS)) return null;
  const review = Object.freeze({
    principalId: canonicalId(value.principalId),
    providerAccountIdentityHash: canonicalHash(value.providerAccountIdentityHash),
    trustDomainIdentityHash: canonicalHash(value.trustDomainIdentityHash),
    reviewReceiptHash: canonicalHash(value.reviewReceiptHash),
    signatureVerificationReceiptHash: canonicalHash(value.signatureVerificationReceiptHash),
    independentFromGenerator: value.independentFromGenerator === true,
  });
  if (Object.values(review).some((candidate) => candidate === null)
    || review.independentFromGenerator !== true
    || review.principalId === generatorPrincipalId) return null;
  return review;
}

function canonicalReceiptInput({
  paperId,
  agendaSelectionReceiptHash,
  generatorPrincipalId,
  queries = [],
  works = [],
  coverageLimitations = [],
  independentReview = null,
  createdAt = null,
  mode = 'verified',
} = {}) {
  const blockers = [];
  const normalizedPaperId = canonicalId(paperId);
  const agendaHash = canonicalHash(agendaSelectionReceiptHash);
  const generator = canonicalId(generatorPrincipalId);
  const normalizedQueries = Array.isArray(queries) ? queries.map(canonicalQuery) : [];
  if (!Array.isArray(queries) || queries.length > 64 || normalizedQueries.some((query) => !query)) {
    blockers.push('prior_art_query_records_invalid');
  }
  const queryIds = new Set(normalizedQueries.filter(Boolean).map((query) => query.queryId));
  if (queryIds.size !== normalizedQueries.length) blockers.push('prior_art_query_ids_duplicate');
  const normalizedWorks = Array.isArray(works)
    ? works.map((work) => canonicalWork(work, queryIds)) : [];
  if (!Array.isArray(works) || works.length > 2_000 || normalizedWorks.some((work) => !work)) {
    blockers.push('prior_art_work_records_invalid');
  }
  const workIds = normalizedWorks.filter(Boolean).map((work) => work.workId);
  if (new Set(workIds).size !== workIds.length) blockers.push('prior_art_work_ids_duplicate');
  const limitations = uniqueText(coverageLimitations, 64, 2_000);
  const review = canonicalReview(independentReview, generator);
  const instant = canonicalInstant(createdAt);
  if (!normalizedPaperId) blockers.push('prior_art_paper_id_invalid');
  if (!agendaHash) blockers.push('prior_art_agenda_binding_invalid');
  if (!generator) blockers.push('prior_art_generator_principal_invalid');
  if (!limitations?.length) blockers.push('prior_art_coverage_limitations_required');
  if (!instant) blockers.push('prior_art_created_at_invalid');
  if (!['verified', 'limited'].includes(mode)) blockers.push('prior_art_evidence_mode_invalid');
  if (mode === 'verified') {
    if (!normalizedQueries.length) blockers.push('prior_art_verified_queries_required');
    if (!review) blockers.push('prior_art_independent_review_required');
  } else if (review || normalizedQueries.length || normalizedWorks.length) {
    blockers.push('prior_art_limited_receipt_cannot_claim_retrieval');
  }
  return Object.freeze({
    blockers: Object.freeze([...new Set(blockers)]),
    paperId: normalizedPaperId,
    agendaSelectionReceiptHash: agendaHash,
    generatorPrincipalId: generator,
    queries: Object.freeze(normalizedQueries.filter(Boolean)),
    works: Object.freeze(normalizedWorks.filter(Boolean)),
    coverageLimitations: limitations || Object.freeze([]),
    independentReview: review,
    createdAt: instant,
    mode,
  });
}

export function buildPriorArtEvidenceReceipt(input = {}) {
  const canonical = canonicalReceiptInput(input);
  const payload = {
    version: 1,
    kind: 'PriorArtEvidenceReceipt',
    status: canonical.blockers.length
      ? 'prior_art_evidence_blocked'
      : canonical.mode === 'verified'
        ? 'prior_art_evidence_verified'
        : 'prior_art_evidence_limited',
    evidenceMode: canonical.mode,
    paperId: canonical.paperId,
    agendaSelectionReceiptHash: canonical.agendaSelectionReceiptHash,
    generatorPrincipalId: canonical.generatorPrincipalId,
    queries: canonical.queries,
    works: canonical.works.map((work) => Object.freeze({
      ...work,
      priorArtWorkRecordHash: hashRecord('PriorArtWorkRecord', work),
    })),
    coverageLimitations: canonical.coverageLimitations,
    independentReview: canonical.independentReview,
    openWorldCompletenessClaimed: false,
    scientificNoveltyVerified: false,
    blockers: canonical.blockers,
    createdAt: canonical.createdAt,
  };
  return Object.freeze({
    ...payload,
    priorArtEvidenceReceiptHash: hashRecord('PriorArtEvidenceReceipt', payload),
  });
}

export function buildLimitedPriorArtEvidenceReceipt({
  paperId,
  agendaSelectionReceiptHash,
  generatorPrincipalId,
  coverageLimitations = [
    'No structured literature retrieval service was configured for this run.',
    'The absence of a retrieved match is not evidence of scientific novelty or exhaustive coverage.',
  ],
  createdAt,
} = {}) {
  return buildPriorArtEvidenceReceipt({
    paperId,
    agendaSelectionReceiptHash,
    generatorPrincipalId,
    queries: [],
    works: [],
    coverageLimitations,
    independentReview: null,
    createdAt,
    mode: 'limited',
  });
}

export function verifyPriorArtEvidenceReceipt(receipt, options = {}) {
  if (receipt?.version === 2) return verifyPriorArtEvidenceReceiptV2(receipt, options);
  const {
    paperId = null,
    agendaSelectionReceiptHash = null,
    requireVerified = false,
  } = options;
  const blockers = [];
  const { priorArtEvidenceReceiptHash: claimedHash, ...payload } = receipt || {};
  if (!canonicalHash(claimedHash)
    || hashRecord('PriorArtEvidenceReceipt', payload) !== claimedHash) {
    blockers.push('prior_art_evidence_receipt_hash_invalid');
  }
  let rebuilt = null;
  try {
    rebuilt = buildPriorArtEvidenceReceipt({
      paperId: receipt?.paperId,
      agendaSelectionReceiptHash: receipt?.agendaSelectionReceiptHash,
      generatorPrincipalId: receipt?.generatorPrincipalId,
      queries: receipt?.queries,
      works: (receipt?.works || []).map(({ priorArtWorkRecordHash: _hash, ...work }) => work),
      coverageLimitations: receipt?.coverageLimitations,
      independentReview: receipt?.independentReview,
      createdAt: receipt?.createdAt,
      mode: receipt?.evidenceMode,
    });
  } catch {
    blockers.push('prior_art_evidence_receipt_rebuild_failed');
  }
  if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(receipt)) {
    blockers.push('prior_art_evidence_receipt_not_canonical');
  }
  if (paperId && receipt?.paperId !== paperId) blockers.push('prior_art_evidence_paper_mismatch');
  if (agendaSelectionReceiptHash
    && receipt?.agendaSelectionReceiptHash !== agendaSelectionReceiptHash) {
    blockers.push('prior_art_evidence_agenda_mismatch');
  }
  if (requireVerified && receipt?.status !== 'prior_art_evidence_verified') {
    blockers.push('prior_art_evidence_verified_receipt_required');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    ready: uniqueBlockers.length === 0 && receipt?.status === 'prior_art_evidence_verified',
    status: uniqueBlockers.length
      ? 'prior_art_evidence_verification_blocked'
      : 'prior_art_evidence_verification_verified',
    priorArtEvidenceReceiptHash: claimedHash || null,
    blockers: uniqueBlockers,
  });
}

export function priorArtEvidenceHashes(receipt) {
  if (receipt?.version === 2) return priorArtEvidenceHashesV2(receipt);
  const verification = verifyPriorArtEvidenceReceipt(receipt);
  if (!verification.valid) return Object.freeze([]);
  return Object.freeze([
    receipt.priorArtEvidenceReceiptHash,
    ...receipt.queries.flatMap((query) => [
      query.corpusSnapshotHash,
      query.resultSetHash,
      query.retrievalReceiptHash,
    ]),
    ...receipt.works.flatMap((work) => [
      work.priorArtWorkRecordHash,
      work.sourceSnapshotHash,
      ...(work.abstractHash ? [work.abstractHash] : []),
    ]),
    ...(receipt.independentReview ? [
      receipt.independentReview.providerAccountIdentityHash,
      receipt.independentReview.trustDomainIdentityHash,
      receipt.independentReview.reviewReceiptHash,
      receipt.independentReview.signatureVerificationReceiptHash,
    ] : []),
  ]);
}
