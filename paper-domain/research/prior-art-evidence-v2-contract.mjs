import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  normalizePriorArtQueryPlan,
  priorArtQueryPlanHash as computePriorArtQueryPlanHash,
} from '../automation/research-agenda-ir.mjs';
import {
  canonicalPriorArtIdentifiers,
  primaryPriorArtIdentity,
  priorArtIdentityKeys,
} from './prior-art-scholarly-identity-v2.mjs';
export {
  normalizePriorArtArxiv,
  normalizePriorArtDoi,
  normalizePriorArtOpenAlex,
} from './prior-art-scholarly-identity-v2.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const ALGORITHM_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

const QUERY_INPUT_KEYS = Object.freeze([
  'executedAt', 'providerResults', 'query', 'queryId',
]);
const PROVIDER_RESULT_INPUT_KEYS = Object.freeze([
  'corpusSnapshotHash', 'providerId', 'providerQueryId', 'resultCount',
  'resultSetHash', 'retrievalReceiptHash',
]);
const WORK_INPUT_KEYS = Object.freeze([
  'abstractHash', 'authors', 'identifiers', 'providerSources', 'title',
  'workId', 'year',
]);
const PROVIDER_SOURCE_INPUT_KEYS = Object.freeze([
  'providerId', 'providerWorkId', 'queryId', 'resultSetHash',
  'sourceSnapshotHash',
]);
const DEDUPLICATION_INPUT_KEYS = Object.freeze([
  'algorithmConfigurationHash', 'algorithmId', 'algorithmVersion',
]);
const RANKING_INPUT_KEYS = Object.freeze([
  'algorithmConfigurationHash', 'algorithmId', 'algorithmVersion', 'entries',
  'queryId', 'sourceResultSetHashes',
]);
const RANKING_ENTRY_KEYS = Object.freeze(['rank', 'scoreMicros', 'workId']);
const REVIEW_KEYS = Object.freeze([
  'independentFromGenerator', 'principalId', 'providerAccountIdentityHash',
  'reviewReceiptHash', 'signatureVerificationReceiptHash', 'trustDomainIdentityHash',
]);

function normalizedText(value, maximum = 8_000) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text && text.length <= maximum ? text : null;
}

function canonicalId(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return SAFE_ID.test(candidate) ? candidate : null;
}

function canonicalHash(value) {
  const candidate = typeof value === 'string' ? value.toLowerCase() : '';
  return SHA256.test(candidate) ? candidate : null;
}

function canonicalInstant(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function uniqueText(values, maximumItems, maximumLength = 2_000) {
  if (!Array.isArray(values) || values.length > maximumItems) return null;
  const normalized = values.map((value) => normalizedText(value, maximumLength));
  if (normalized.some((value) => !value) || new Set(normalized).size !== normalized.length) {
    return null;
  }
  return Object.freeze(normalized);
}

export function priorArtExecutedQueriesMatchPlanV2(queries, priorArtQueryPlan) {
  const normalizedPlan = normalizePriorArtQueryPlan(priorArtQueryPlan);
  if (!normalizedPlan || !Array.isArray(queries) || queries.length !== normalizedPlan.length) {
    return false;
  }
  const executed = queries.map((query) => normalizedText(query?.query, 2_000));
  if (executed.some((query) => !query)
    || new Set(executed).size !== executed.length) return false;
  return JSON.stringify([...executed].sort())
    === JSON.stringify([...normalizedPlan].sort());
}

function canonicalAlgorithm(value = {}) {
  if (!hasExactObjectKeys(value, DEDUPLICATION_INPUT_KEYS)) return null;
  const algorithmId = canonicalId(value.algorithmId);
  const algorithmVersion = typeof value.algorithmVersion === 'string'
    && ALGORITHM_VERSION.test(value.algorithmVersion) ? value.algorithmVersion : null;
  const algorithmConfigurationHash = canonicalHash(value.algorithmConfigurationHash);
  return algorithmId && algorithmVersion && algorithmConfigurationHash
    ? Object.freeze({ algorithmId, algorithmVersion, algorithmConfigurationHash })
    : null;
}

function canonicalProviderResult(value) {
  if (!hasExactObjectKeys(value, PROVIDER_RESULT_INPUT_KEYS)) return null;
  const providerId = canonicalId(value.providerId);
  const providerQueryId = canonicalId(value.providerQueryId);
  const corpusSnapshotHash = canonicalHash(value.corpusSnapshotHash);
  const resultSetHash = canonicalHash(value.resultSetHash);
  const retrievalReceiptHash = canonicalHash(value.retrievalReceiptHash);
  const resultCount = Number(value.resultCount);
  if (!providerId || !providerQueryId || !corpusSnapshotHash || !resultSetHash
    || !retrievalReceiptHash || !Number.isSafeInteger(resultCount)
    || resultCount < 0 || resultCount > 2_000) return null;
  const payload = {
    providerId,
    providerQueryId,
    corpusSnapshotHash,
    resultSetHash,
    retrievalReceiptHash,
    resultCount,
  };
  return Object.freeze({
    ...payload,
    providerResultRecordHash: hashRecord('PriorArtProviderResultRecordV2', payload),
  });
}

function aggregateProviderHash(kind, providerResults, field) {
  return hashRecord(kind, providerResults.map((result) => Object.freeze({
    providerId: result.providerId,
    [field]: result[field],
  })));
}

function canonicalQuery(value) {
  if (!hasExactObjectKeys(value, QUERY_INPUT_KEYS)) return null;
  const queryId = canonicalId(value.queryId);
  const query = normalizedText(value.query, 4_000);
  const executedAt = canonicalInstant(value.executedAt);
  const providerResults = Array.isArray(value.providerResults)
    && value.providerResults.length >= 1 && value.providerResults.length <= 16
    ? value.providerResults.map(canonicalProviderResult) : null;
  if (!queryId || !query || !executedAt || !providerResults
    || providerResults.some((result) => !result)) return null;
  const sortedResults = [...providerResults].sort((left, right) => (
    left.providerId.localeCompare(right.providerId)
      || left.providerQueryId.localeCompare(right.providerQueryId)
  ));
  if (new Set(sortedResults.map((result) => result.providerId)).size
    !== sortedResults.length) return null;
  const payload = {
    queryId,
    query,
    providers: Object.freeze(sortedResults.map((result) => result.providerId)),
    executedAt,
    corpusSnapshotHash: aggregateProviderHash(
      'PriorArtCorpusSnapshotSetV2', sortedResults, 'corpusSnapshotHash',
    ),
    resultSetHash: aggregateProviderHash(
      'PriorArtResultSetHashSetV2', sortedResults, 'resultSetHash',
    ),
    retrievalReceiptHash: aggregateProviderHash(
      'PriorArtRetrievalReceiptHashSetV2', sortedResults, 'retrievalReceiptHash',
    ),
    providerResults: Object.freeze(sortedResults),
  };
  return Object.freeze({
    ...payload,
    priorArtQueryRecordHash: hashRecord('PriorArtQueryRecordV2', payload),
  });
}

function canonicalProviderSource(value, queryMap) {
  if (!hasExactObjectKeys(value, PROVIDER_SOURCE_INPUT_KEYS)) return null;
  const providerId = canonicalId(value.providerId);
  const providerWorkId = canonicalId(value.providerWorkId);
  const queryId = canonicalId(value.queryId);
  const resultSetHash = canonicalHash(value.resultSetHash);
  const sourceSnapshotHash = canonicalHash(value.sourceSnapshotHash);
  const providerResult = queryMap.get(queryId)?.providerResults
    .find((candidate) => candidate.providerId === providerId);
  if (!providerId || !providerWorkId || !queryId || !resultSetHash || !sourceSnapshotHash
    || !providerResult || providerResult.resultSetHash !== resultSetHash) return null;
  const payload = {
    providerId, providerWorkId, queryId, resultSetHash, sourceSnapshotHash,
  };
  return Object.freeze({
    ...payload,
    providerWorkIdentityHash: hashRecord('PriorArtProviderWorkIdentityV2', {
      providerId, providerWorkId,
    }),
    providerSourceRecordHash: hashRecord('PriorArtProviderSourceRecordV2', payload),
  });
}

function canonicalWork(value, queryMap) {
  if (!hasExactObjectKeys(value, WORK_INPUT_KEYS)) return null;
  const workId = canonicalId(value.workId);
  const title = normalizedText(value.title, 4_000);
  const authors = uniqueText(value.authors, 128, 500);
  const year = value.year === null ? null : Number(value.year);
  const identifiers = canonicalPriorArtIdentifiers(value.identifiers);
  const abstractHash = value.abstractHash === null ? null : canonicalHash(value.abstractHash);
  const providerSources = Array.isArray(value.providerSources)
    && value.providerSources.length >= 1 && value.providerSources.length <= 128
    ? value.providerSources.map((source) => canonicalProviderSource(source, queryMap)) : null;
  if (!workId || !title || !authors?.length || !identifiers || !providerSources
    || providerSources.some((source) => !source)
    || (year !== null && (!Number.isInteger(year) || year < 1000 || year > 3000))
    || (value.abstractHash !== null && !abstractHash)) return null;
  const sortedSources = [...providerSources].sort((left, right) => (
    left.queryId.localeCompare(right.queryId)
      || left.providerId.localeCompare(right.providerId)
      || left.providerWorkId.localeCompare(right.providerWorkId)
  ));
  const sourceKeys = sortedSources.map((source) => (
    `${source.queryId}\0${source.providerId}\0${source.providerWorkId}`
  ));
  if (new Set(sourceKeys).size !== sourceKeys.length) return null;
  const canonicalIdentity = primaryPriorArtIdentity(identifiers);
  const payload = {
    workId,
    title,
    authors,
    year,
    identifiers,
    canonicalIdentity,
    queryIds: Object.freeze([...new Set(sortedSources.map((source) => source.queryId))].sort()),
    sourceSnapshotHash: hashRecord(
      'PriorArtWorkSourceSnapshotSetV2',
      sortedSources.map((source) => source.providerSourceRecordHash),
    ),
    abstractHash,
    providerSources: Object.freeze(sortedSources),
  };
  return Object.freeze({
    ...payload,
    priorArtWorkRecordHash: hashRecord('PriorArtWorkRecordV2', payload),
  });
}

function canonicalReview(value, generatorPrincipalId) {
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

function inspectWorkIdentityConflicts(works) {
  const blockers = [];
  const identityOwners = new Map();
  const providerWorkOwners = new Map();
  for (const work of works) {
    for (const identity of priorArtIdentityKeys(work.identifiers)) {
      const owner = identityOwners.get(identity);
      if (owner && owner !== work.workId) blockers.push('prior_art_v2_canonical_identity_conflict');
      else identityOwners.set(identity, work.workId);
    }
    for (const source of work.providerSources) {
      const identity = `${source.providerId}\0${source.providerWorkId}`;
      const owner = providerWorkOwners.get(identity);
      if (owner && owner !== work.workId) {
        blockers.push('prior_art_v2_provider_work_identity_conflict');
      } else {
        providerWorkOwners.set(identity, work.workId);
      }
    }
  }
  return blockers;
}

function inspectProviderResultCounts(queries, works) {
  const actual = new Map();
  for (const work of works) {
    for (const source of work.providerSources) {
      const key = `${source.queryId}\0${source.providerId}`;
      actual.set(key, (actual.get(key) || 0) + 1);
    }
  }
  return queries.flatMap((query) => query.providerResults.flatMap((result) => (
    actual.get(`${query.queryId}\0${result.providerId}`) === result.resultCount
      ? [] : ['prior_art_v2_provider_result_count_mismatch']
  )));
}

function buildDeduplicationReceipt(algorithm, works) {
  if (!algorithm) return null;
  const canonicalGroups = works.map((work) => Object.freeze({
    workId: work.workId,
    canonicalIdentityHash: work.canonicalIdentity.canonicalIdentityHash,
    providerWorkIdentityHashes: Object.freeze([...new Set(
      work.providerSources.map((source) => source.providerWorkIdentityHash),
    )].sort()),
    providerSourceRecordHashes: Object.freeze(
      work.providerSources.map((source) => source.providerSourceRecordHash).sort(),
    ),
  })).sort((left, right) => left.workId.localeCompare(right.workId));
  const sourceRecordHashes = canonicalGroups
    .flatMap((group) => group.providerSourceRecordHashes).sort();
  const providerWorkIdentityHashes = canonicalGroups
    .flatMap((group) => group.providerWorkIdentityHashes).sort();
  const payload = {
    version: 1,
    kind: 'PriorArtDeduplicationReceipt',
    ...algorithm,
    inputRecordCount: providerWorkIdentityHashes.length,
    canonicalWorkCount: works.length,
    duplicateRecordCount: providerWorkIdentityHashes.length - works.length,
    retrievalSourceRecordCount: sourceRecordHashes.length,
    providerWorkIdentityHashes: Object.freeze(providerWorkIdentityHashes),
    sourceRecordHashes: Object.freeze(sourceRecordHashes),
    canonicalGroups: Object.freeze(canonicalGroups),
  };
  if (payload.duplicateRecordCount < 0) return null;
  return Object.freeze({
    ...payload,
    deduplicationReceiptHash: hashRecord('PriorArtDeduplicationReceipt', payload),
  });
}

function canonicalRanking(value, { query, works }) {
  if (!hasExactObjectKeys(value, RANKING_INPUT_KEYS)) return null;
  const queryId = canonicalId(value.queryId);
  const algorithmId = canonicalId(value.algorithmId);
  const algorithmVersion = typeof value.algorithmVersion === 'string'
    && ALGORITHM_VERSION.test(value.algorithmVersion) ? value.algorithmVersion : null;
  const algorithmConfigurationHash = canonicalHash(value.algorithmConfigurationHash);
  const sourceResultSetHashes = Array.isArray(value.sourceResultSetHashes)
    && value.sourceResultSetHashes.length >= 1 && value.sourceResultSetHashes.length <= 16
    ? value.sourceResultSetHashes.map(canonicalHash) : null;
  const entries = Array.isArray(value.entries) && value.entries.length <= 2_000
    ? value.entries.map((entry) => {
      if (!hasExactObjectKeys(entry, RANKING_ENTRY_KEYS)) return null;
      const workId = canonicalId(entry.workId);
      const rank = Number(entry.rank);
      const scoreMicros = Number(entry.scoreMicros);
      return workId && Number.isSafeInteger(rank) && rank >= 1
        && Number.isSafeInteger(scoreMicros) && scoreMicros >= 0 && scoreMicros <= 1_000_000
        ? Object.freeze({ workId, rank, scoreMicros }) : null;
    }) : null;
  if (!query || queryId !== query.queryId || !algorithmId || !algorithmVersion
    || !algorithmConfigurationHash || !sourceResultSetHashes
    || sourceResultSetHashes.some((hash) => !hash) || !entries
    || entries.some((entry) => !entry)) return null;
  const expectedSourceHashes = query.providerResults.map((result) => result.resultSetHash).sort();
  const declaredSourceHashes = [...sourceResultSetHashes].sort();
  if (new Set(declaredSourceHashes).size !== declaredSourceHashes.length
    || JSON.stringify(declaredSourceHashes) !== JSON.stringify(expectedSourceHashes)) return null;
  const sortedEntries = [...entries].sort((left, right) => left.rank - right.rank);
  if (new Set(sortedEntries.map((entry) => entry.workId)).size !== sortedEntries.length
    || sortedEntries.some((entry, index) => entry.rank !== index + 1)
    || sortedEntries.some((entry, index) => (
      index > 0 && entry.scoreMicros > sortedEntries[index - 1].scoreMicros
    ))) return null;
  const expectedWorkIds = works
    .filter((work) => work.queryIds.includes(queryId)).map((work) => work.workId).sort();
  const rankedWorkIds = sortedEntries.map((entry) => entry.workId).sort();
  if (JSON.stringify(rankedWorkIds) !== JSON.stringify(expectedWorkIds)) return null;
  const payload = {
    version: 1,
    kind: 'PriorArtRankingReceipt',
    queryId,
    algorithmId,
    algorithmVersion,
    algorithmConfigurationHash,
    sourceResultSetHashes: Object.freeze(declaredSourceHashes),
    rankedWorkCount: sortedEntries.length,
    entries: Object.freeze(sortedEntries),
  };
  return Object.freeze({
    ...payload,
    rankingReceiptHash: hashRecord('PriorArtRankingReceipt', payload),
  });
}

function inputFromReceipt(receipt) {
  return {
    paperId: receipt?.paperId,
    agendaSelectionReceiptHash: receipt?.agendaSelectionReceiptHash,
    researchAgendaIrHash: receipt?.researchAgendaIrHash,
    priorArtQueryPlan: receipt?.priorArtQueryPlan,
    generatorPrincipalId: receipt?.generatorPrincipalId,
    queries: (receipt?.queries || []).map((query) => ({
      queryId: query.queryId,
      query: query.query,
      executedAt: query.executedAt,
      providerResults: (query.providerResults || []).map((result) => ({
        providerId: result.providerId,
        providerQueryId: result.providerQueryId,
        corpusSnapshotHash: result.corpusSnapshotHash,
        resultSetHash: result.resultSetHash,
        retrievalReceiptHash: result.retrievalReceiptHash,
        resultCount: result.resultCount,
      })),
    })),
    works: (receipt?.works || []).map((work) => ({
      workId: work.workId,
      title: work.title,
      authors: work.authors,
      year: work.year,
      identifiers: work.identifiers,
      abstractHash: work.abstractHash,
      providerSources: (work.providerSources || []).map((source) => ({
        providerId: source.providerId,
        providerWorkId: source.providerWorkId,
        queryId: source.queryId,
        resultSetHash: source.resultSetHash,
        sourceSnapshotHash: source.sourceSnapshotHash,
      })),
    })),
    deduplication: receipt?.deduplicationReceipt ? {
      algorithmId: receipt.deduplicationReceipt.algorithmId,
      algorithmVersion: receipt.deduplicationReceipt.algorithmVersion,
      algorithmConfigurationHash: receipt.deduplicationReceipt.algorithmConfigurationHash,
    } : null,
    rankings: (receipt?.rankingReceipts || []).map((ranking) => ({
      queryId: ranking.queryId,
      algorithmId: ranking.algorithmId,
      algorithmVersion: ranking.algorithmVersion,
      algorithmConfigurationHash: ranking.algorithmConfigurationHash,
      sourceResultSetHashes: ranking.sourceResultSetHashes,
      entries: ranking.entries,
    })),
    coverageLimitations: receipt?.coverageLimitations,
    independentReview: receipt?.independentReview,
    createdAt: receipt?.createdAt,
    mode: receipt?.evidenceMode,
  };
}

export function buildPriorArtEvidenceReceiptV2({
  paperId,
  agendaSelectionReceiptHash,
  researchAgendaIrHash,
  priorArtQueryPlan,
  generatorPrincipalId,
  queries = [],
  works = [],
  deduplication = null,
  rankings = [],
  coverageLimitations = [],
  independentReview = null,
  createdAt = null,
  mode = 'verified',
} = {}) {
  const blockers = [];
  const normalizedPaperId = canonicalId(paperId);
  const agendaHash = canonicalHash(agendaSelectionReceiptHash);
  const agendaIrHash = canonicalHash(researchAgendaIrHash);
  const normalizedQueryPlan = normalizePriorArtQueryPlan(priorArtQueryPlan);
  const queryPlanHash = computePriorArtQueryPlanHash(normalizedQueryPlan);
  const generator = canonicalId(generatorPrincipalId);
  const normalizedQueries = Array.isArray(queries) && queries.length <= 64
    ? queries.map(canonicalQuery) : [];
  if (!Array.isArray(queries) || queries.length > 64
    || normalizedQueries.some((query) => !query)) blockers.push('prior_art_v2_query_records_invalid');
  const selectedQueries = normalizedQueries.filter(Boolean)
    .sort((left, right) => left.queryId.localeCompare(right.queryId));
  if (new Set(selectedQueries.map((query) => query.queryId)).size !== selectedQueries.length) {
    blockers.push('prior_art_v2_query_ids_duplicate');
  }
  if (!normalizedQueryPlan || !queryPlanHash) {
    blockers.push('prior_art_v2_query_plan_binding_invalid');
  } else if (!priorArtExecutedQueriesMatchPlanV2(selectedQueries, normalizedQueryPlan)) {
    blockers.push('prior_art_v2_executed_query_plan_bijection_invalid');
  }
  const queryMap = new Map(selectedQueries.map((query) => [query.queryId, query]));
  const normalizedWorks = Array.isArray(works) && works.length <= 2_000
    ? works.map((work) => canonicalWork(work, queryMap)) : [];
  if (!Array.isArray(works) || works.length > 2_000
    || normalizedWorks.some((work) => !work)) blockers.push('prior_art_v2_work_records_invalid');
  const selectedWorks = normalizedWorks.filter(Boolean)
    .sort((left, right) => left.workId.localeCompare(right.workId));
  if (new Set(selectedWorks.map((work) => work.workId)).size !== selectedWorks.length) {
    blockers.push('prior_art_v2_work_ids_duplicate');
  }
  blockers.push(...inspectWorkIdentityConflicts(selectedWorks));
  blockers.push(...inspectProviderResultCounts(selectedQueries, selectedWorks));
  const deduplicationAlgorithm = canonicalAlgorithm(deduplication);
  const deduplicationReceipt = buildDeduplicationReceipt(
    deduplicationAlgorithm, selectedWorks,
  );
  if (!deduplicationAlgorithm || !deduplicationReceipt) {
    blockers.push('prior_art_v2_deduplication_contract_invalid');
  }
  const normalizedRankings = Array.isArray(rankings) && rankings.length <= 64
    ? rankings.map((ranking) => canonicalRanking(ranking, {
      query: queryMap.get(canonicalId(ranking?.queryId)), works: selectedWorks,
    })) : [];
  if (!Array.isArray(rankings) || rankings.length > 64
    || normalizedRankings.some((ranking) => !ranking)) {
    blockers.push('prior_art_v2_ranking_records_invalid');
  }
  const rankingReceipts = normalizedRankings.filter(Boolean)
    .sort((left, right) => left.queryId.localeCompare(right.queryId));
  if (new Set(rankingReceipts.map((ranking) => ranking.queryId)).size
      !== rankingReceipts.length
    || JSON.stringify(rankingReceipts.map((ranking) => ranking.queryId))
      !== JSON.stringify(selectedQueries.map((query) => query.queryId))) {
    blockers.push('prior_art_v2_query_ranking_coverage_invalid');
  }
  const limitations = uniqueText(coverageLimitations, 64, 2_000);
  const review = canonicalReview(independentReview, generator);
  const instant = canonicalInstant(createdAt);
  if (!normalizedPaperId) blockers.push('prior_art_v2_paper_id_invalid');
  if (!agendaHash) blockers.push('prior_art_v2_agenda_binding_invalid');
  if (!agendaIrHash) blockers.push('prior_art_v2_research_agenda_ir_binding_invalid');
  if (!generator) blockers.push('prior_art_v2_generator_principal_invalid');
  if (!limitations?.length) blockers.push('prior_art_v2_coverage_limitations_required');
  if (!instant) blockers.push('prior_art_v2_created_at_invalid');
  if (mode !== 'verified') blockers.push('prior_art_v2_verified_mode_required');
  if (!selectedQueries.length) blockers.push('prior_art_v2_verified_queries_required');
  if (!review) blockers.push('prior_art_v2_independent_review_required');
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 2,
    kind: 'PriorArtEvidenceReceipt',
    evidenceProfile: 'structured-ranked-deduplicated-v2',
    status: uniqueBlockers.length
      ? 'prior_art_evidence_blocked' : 'prior_art_evidence_verified',
    evidenceMode: 'verified',
    paperId: normalizedPaperId,
    agendaSelectionReceiptHash: agendaHash,
    researchAgendaIrHash: agendaIrHash,
    priorArtQueryPlan: normalizedQueryPlan || Object.freeze([]),
    priorArtQueryPlanHash: queryPlanHash,
    generatorPrincipalId: generator,
    queries: Object.freeze(selectedQueries),
    works: Object.freeze(selectedWorks),
    deduplicationReceipt,
    rankingReceipts: Object.freeze(rankingReceipts),
    coverageLimitations: limitations || Object.freeze([]),
    independentReview: review,
    openWorldCompletenessClaimed: false,
    scientificNoveltyVerified: false,
    blockers: uniqueBlockers,
    createdAt: instant,
  };
  return Object.freeze({
    ...payload,
    priorArtEvidenceReceiptHash: hashRecord('PriorArtEvidenceReceiptV2', payload),
  });
}

export function verifyPriorArtEvidenceReceiptV2(receipt, {
  paperId = null,
  agendaSelectionReceiptHash = null,
  researchAgendaIrHash = null,
  priorArtQueryPlan = null,
  priorArtQueryPlanHash: expectedPriorArtQueryPlanHash = null,
  requireVerified = false,
} = {}) {
  const blockers = [];
  const { priorArtEvidenceReceiptHash: claimedHash, ...payload } = receipt || {};
  if (receipt?.version !== 2 || receipt?.kind !== 'PriorArtEvidenceReceipt'
    || receipt?.evidenceProfile !== 'structured-ranked-deduplicated-v2') {
    blockers.push('prior_art_v2_receipt_shape_invalid');
  }
  if (!canonicalHash(claimedHash)
    || hashRecord('PriorArtEvidenceReceiptV2', payload) !== claimedHash) {
    blockers.push('prior_art_v2_receipt_hash_invalid');
  }
  let rebuilt = null;
  try { rebuilt = buildPriorArtEvidenceReceiptV2(inputFromReceipt(receipt)); }
  catch { blockers.push('prior_art_v2_receipt_rebuild_failed'); }
  if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(receipt)) {
    blockers.push('prior_art_v2_receipt_not_canonical');
  }
  if (paperId && receipt?.paperId !== paperId) blockers.push('prior_art_v2_paper_mismatch');
  if (agendaSelectionReceiptHash
    && receipt?.agendaSelectionReceiptHash !== agendaSelectionReceiptHash) {
    blockers.push('prior_art_v2_agenda_mismatch');
  }
  if (researchAgendaIrHash && receipt?.researchAgendaIrHash !== researchAgendaIrHash) {
    blockers.push('prior_art_v2_research_agenda_ir_mismatch');
  }
  if (priorArtQueryPlan !== null) {
    const normalizedPlan = normalizePriorArtQueryPlan(priorArtQueryPlan);
    const computedPlanHash = computePriorArtQueryPlanHash(normalizedPlan);
    if (!normalizedPlan || !computedPlanHash
      || (expectedPriorArtQueryPlanHash !== null
        && expectedPriorArtQueryPlanHash !== computedPlanHash)) {
      blockers.push('prior_art_v2_expected_query_plan_invalid');
    } else {
      if (receipt?.priorArtQueryPlanHash !== computedPlanHash
        || JSON.stringify(receipt?.priorArtQueryPlan) !== JSON.stringify(normalizedPlan)) {
        blockers.push('prior_art_v2_query_plan_mismatch');
      }
      if (!priorArtExecutedQueriesMatchPlanV2(receipt?.queries, normalizedPlan)) {
        blockers.push('prior_art_v2_executed_query_plan_bijection_invalid');
      }
    }
  } else if (expectedPriorArtQueryPlanHash !== null
    && receipt?.priorArtQueryPlanHash !== expectedPriorArtQueryPlanHash) {
    blockers.push('prior_art_v2_query_plan_hash_mismatch');
  }
  if (requireVerified && receipt?.status !== 'prior_art_evidence_verified') {
    blockers.push('prior_art_v2_verified_receipt_required');
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

export function priorArtEvidenceHashesV2(receipt) {
  const verification = verifyPriorArtEvidenceReceiptV2(receipt);
  if (!verification.valid) return Object.freeze([]);
  return Object.freeze([
    receipt.priorArtEvidenceReceiptHash,
    receipt.researchAgendaIrHash,
    receipt.priorArtQueryPlanHash,
    receipt.deduplicationReceipt.deduplicationReceiptHash,
    ...receipt.queries.flatMap((query) => [
      query.priorArtQueryRecordHash,
      query.corpusSnapshotHash,
      query.resultSetHash,
      query.retrievalReceiptHash,
      ...query.providerResults.flatMap((provider) => [
        provider.providerResultRecordHash,
        provider.corpusSnapshotHash,
        provider.resultSetHash,
        provider.retrievalReceiptHash,
      ]),
    ]),
    ...receipt.works.flatMap((work) => [
      work.priorArtWorkRecordHash,
      work.canonicalIdentity.canonicalIdentityHash,
      work.sourceSnapshotHash,
      ...(work.abstractHash ? [work.abstractHash] : []),
      ...work.providerSources.flatMap((source) => [
        source.providerWorkIdentityHash,
        source.providerSourceRecordHash,
        source.sourceSnapshotHash,
        source.resultSetHash,
      ]),
    ]),
    ...receipt.rankingReceipts.flatMap((ranking) => [
      ranking.rankingReceiptHash,
      ranking.algorithmConfigurationHash,
      ...ranking.sourceResultSetHashes,
    ]),
    receipt.independentReview.providerAccountIdentityHash,
    receipt.independentReview.trustDomainIdentityHash,
    receipt.independentReview.reviewReceiptHash,
    receipt.independentReview.signatureVerificationReceiptHash,
  ]);
}
