import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLimitedPriorArtEvidenceReceipt,
  buildPriorArtEvidenceReceipt,
  buildPriorArtEvidenceReceiptV2,
  normalizePriorArtArxiv,
  normalizePriorArtDoi,
  normalizePriorArtOpenAlex,
  priorArtEvidenceHashes,
  verifyPriorArtEvidenceReceipt,
  verifyPriorArtEvidenceReceiptV2,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import {
  buildEvidenceBoundManuscriptIrDraft,
  evidenceBoundManuscriptBlockBody,
  evidenceBoundManuscriptMarkerDeclaration,
  evidenceBoundManuscriptMarkerDeclarationValid,
  evidenceBoundManuscriptSectionHeadings,
  finalizeEvidenceBoundManuscriptIr,
  latexEscapeEvidenceBoundText,
  verifyEvidenceBoundManuscriptIr,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  buildResearchAgendaIr,
  priorArtQueryPlanHash,
} from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  buildPriorArtClaimAlignmentReceipt,
  conservativePriorArtClaimAlignmentRecords,
} from '../../paper-domain/research/prior-art-claim-alignment-contract.mjs';
import {
  digest,
  manuscriptIrFixture,
  priorArtFixture,
  priorArtV2Fixture,
} from './support/autonomous-research-generalization-fixture.mjs';

function inputFromReceipt(receipt) {
  return {
    paperId: receipt.paperId,
    agendaSelectionReceiptHash: receipt.agendaSelectionReceiptHash,
    researchAgendaIrHash: receipt.researchAgendaIrHash,
    priorArtQueryPlan: receipt.priorArtQueryPlan,
    generatorPrincipalId: receipt.generatorPrincipalId,
    queries: receipt.queries.map((query) => ({
      queryId: query.queryId,
      query: query.query,
      executedAt: query.executedAt,
      providerResults: query.providerResults.map((result) => ({
        providerId: result.providerId,
        providerQueryId: result.providerQueryId,
        corpusSnapshotHash: result.corpusSnapshotHash,
        resultSetHash: result.resultSetHash,
        retrievalReceiptHash: result.retrievalReceiptHash,
        resultCount: result.resultCount,
      })),
    })),
    works: receipt.works.map((work) => ({
      workId: work.workId,
      title: work.title,
      authors: work.authors,
      year: work.year,
      identifiers: work.identifiers,
      abstractHash: work.abstractHash,
      providerSources: work.providerSources.map((source) => ({
        providerId: source.providerId,
        providerWorkId: source.providerWorkId,
        queryId: source.queryId,
        resultSetHash: source.resultSetHash,
        sourceSnapshotHash: source.sourceSnapshotHash,
      })),
    })),
    deduplication: {
      algorithmId: receipt.deduplicationReceipt.algorithmId,
      algorithmVersion: receipt.deduplicationReceipt.algorithmVersion,
      algorithmConfigurationHash: receipt.deduplicationReceipt.algorithmConfigurationHash,
    },
    rankings: receipt.rankingReceipts.map((ranking) => ({
      queryId: ranking.queryId,
      algorithmId: ranking.algorithmId,
      algorithmVersion: ranking.algorithmVersion,
      algorithmConfigurationHash: ranking.algorithmConfigurationHash,
      sourceResultSetHashes: ranking.sourceResultSetHashes,
      entries: ranking.entries,
    })),
    coverageLimitations: receipt.coverageLimitations,
    independentReview: receipt.independentReview,
    createdAt: receipt.createdAt,
    mode: receipt.evidenceMode,
  };
}

function v1InputFromReceipt(receipt) {
  return {
    paperId: receipt.paperId,
    agendaSelectionReceiptHash: receipt.agendaSelectionReceiptHash,
    generatorPrincipalId: receipt.generatorPrincipalId,
    queries: structuredClone(receipt.queries),
    works: receipt.works.map(({ priorArtWorkRecordHash: _hash, ...work }) => (
      structuredClone(work)
    )),
    coverageLimitations: structuredClone(receipt.coverageLimitations),
    independentReview: structuredClone(receipt.independentReview),
    createdAt: receipt.createdAt,
    mode: receipt.evidenceMode,
  };
}

function addSecondWork(input, {
  duplicateDoi = false,
  duplicateArxivBase = false,
  duplicateOpenAlex = false,
  duplicateProviderWorkId = false,
  scores = [900_000, 800_000],
} = {}) {
  const selected = structuredClone(input);
  for (const result of selected.queries[0].providerResults) result.resultCount = 2;
  const first = selected.works[0];
  selected.works.push({
    workId: 'work-2',
    title: 'A second auditable research system',
    authors: ['Grace Researcher'],
    year: 2024,
    identifiers: {
      doi: duplicateDoi ? 'doi:10.0000/example.1' : '10.0000/example.2',
      arxiv: duplicateArxivBase ? '2501.01234v3' : '2501.01235v1',
      openAlex: duplicateOpenAlex ? 'openalex:W123456789' : 'W123456790',
      url: 'https://example.test/auditable-research-2',
    },
    providerSources: first.providerSources.map((source) => ({
      ...source,
      providerWorkId: duplicateProviderWorkId
        ? source.providerWorkId : `${source.providerWorkId}-2`,
      sourceSnapshotHash: digest(`${source.providerId}-work-2`),
    })),
    abstractHash: digest('abstract-2'),
  });
  selected.rankings[0].entries = [
    { workId: 'work-1', rank: 1, scoreMicros: scores[0] },
    { workId: 'work-2', rank: 2, scoreMicros: scores[1] },
  ];
  return selected;
}

function addSecondQuery(input, query = 'an unplanned extra executed query') {
  const selected = structuredClone(input);
  const secondQuery = structuredClone(selected.queries[0]);
  secondQuery.queryId = 'query-2';
  secondQuery.query = query;
  secondQuery.providerResults = secondQuery.providerResults.map((provider) => ({
    ...provider,
    providerQueryId: `${provider.providerQueryId}-extra`,
    resultSetHash: digest(`${provider.providerId}:extra-result-set`),
    retrievalReceiptHash: digest(`${provider.providerId}:extra-retrieval`),
    resultCount: 1,
  }));
  selected.queries.push(secondQuery);
  selected.works[0].providerSources.push(...secondQuery.providerResults.map((provider) => ({
    providerId: provider.providerId,
    providerWorkId: `${provider.providerId}-work-extra`,
    queryId: 'query-2',
    resultSetHash: provider.resultSetHash,
    sourceSnapshotHash: digest(`${provider.providerId}:extra-work`),
  })));
  selected.rankings.push({
    ...structuredClone(selected.rankings[0]),
    queryId: 'query-2',
    sourceResultSetHashes: secondQuery.providerResults.map((provider) => provider.resultSetHash),
    entries: [{ workId: 'work-1', rank: 1, scoreMicros: 850_000 }],
  });
  return selected;
}

function agendaIr(priorArtQueryPlan) {
  return buildResearchAgendaIr({
    agendaProductionReceipt: {
      autonomousResearchAgendaProductionReceiptHash: digest('agenda-production'),
      paperId: 'paper-generalized-1',
      selectedProtocolFamily: 'ml_algorithm_benchmark',
    },
    researchQuestion: 'Does the bounded intervention improve the primary metric?',
    primaryClaim: 'The bounded intervention improves the primary metric.',
    dataRequirements: {
      population: 'Rows admitted by the signed benchmark.',
      intervention: 'Bounded intervention.',
      comparator: 'Fixed control.',
      estimand: 'Paired primary-metric difference.',
      requiredVariables: ['outcome', 'assignment'],
      datasetConstraints: ['read-only signed dataset mount'],
    },
    falsifiers: ['A non-positive paired primary-metric difference.'],
    negativeBoundaries: ['No claim outside the signed population.'],
    formalTargets: ['Kernel-check the aggregation invariant.'],
    priorArtQueryPlan,
    venueConstraints: {
      paperType: 'research_article',
      requiredSections: ['methods', 'results', 'limitations'],
      artifactRequired: true,
      anonymousReviewRequired: true,
    },
    resourceFeasibility: {
      maximumWallTimeMs: 3_600_000,
      maximumMemoryBytes: 8_589_934_592,
      maximumCpuCount: 4,
      executionEnvironment: 'signed-python-runtime-v1',
    },
    skipSourceVerification: true,
  });
}

test('v2 normalizes DOI, arXiv, and OpenAlex identities without resolver aliases', () => {
  assert.equal(normalizePriorArtDoi('https://doi.org/10.1000/ABC.1'), '10.1000/abc.1');
  assert.equal(normalizePriorArtDoi(' DOI: 10.1000/abc.1 '), '10.1000/abc.1');
  assert.equal(normalizePriorArtArxiv('https://arxiv.org/pdf/2401.01234v2.pdf'),
    '2401.01234v2');
  assert.equal(normalizePriorArtArxiv('arXiv:HEP-TH/9901001v3'),
    'hep-th/9901001v3');
  assert.equal(normalizePriorArtOpenAlex('https://openalex.org/w123456'), 'W123456');
  assert.equal(normalizePriorArtOpenAlex('openalex:W123456'), 'W123456');
  assert.equal(normalizePriorArtDoi('https://example.test/10.1000/abc'), null);
  assert.equal(normalizePriorArtArxiv('2401.invalid'), null);
  assert.equal(normalizePriorArtOpenAlex('A123'), null);
});

test('v2 receipt binds provider provenance, canonical dedupe, ranking, and old consumers', () => {
  const receipt = priorArtV2Fixture();
  assert.equal(receipt.version, 2);
  assert.equal(receipt.evidenceProfile, 'structured-ranked-deduplicated-v2');
  assert.equal(receipt.status, 'prior_art_evidence_verified');
  assert.deepEqual(receipt.blockers, []);
  assert.equal(receipt.priorArtQueryPlanHash,
    priorArtQueryPlanHash(receipt.priorArtQueryPlan));
  assert.deepEqual(receipt.works[0].identifiers, {
    doi: '10.0000/example.1',
    arxiv: '2501.01234v2',
    openAlex: 'W123456789',
    url: 'https://example.test/auditable-research',
  });
  assert.equal(receipt.works[0].canonicalIdentity.scheme, 'doi');
  assert.equal(receipt.deduplicationReceipt.inputRecordCount, 2);
  assert.equal(receipt.deduplicationReceipt.canonicalWorkCount, 1);
  assert.equal(receipt.deduplicationReceipt.duplicateRecordCount, 1);
  assert.equal(receipt.deduplicationReceipt.retrievalSourceRecordCount, 2);
  assert.equal(receipt.deduplicationReceipt.providerWorkIdentityHashes.length, 2);
  assert.equal(receipt.deduplicationReceipt.canonicalGroups[0]
    .providerSourceRecordHashes.length, 2);
  assert.equal(receipt.rankingReceipts[0].rankedWorkCount, 1);
  assert.deepEqual(receipt.rankingReceipts[0].entries,
    [{ workId: 'work-1', rank: 1, scoreMicros: 900_000 }]);
  assert.equal(verifyPriorArtEvidenceReceiptV2(receipt, {
    paperId: receipt.paperId,
    agendaSelectionReceiptHash: receipt.agendaSelectionReceiptHash,
    requireVerified: true,
  }).ready, true);
  assert.equal(verifyPriorArtEvidenceReceipt(receipt, { requireVerified: true }).ready, true);
  const hashes = priorArtEvidenceHashes(receipt);
  assert.ok(hashes.includes(receipt.deduplicationReceipt.deduplicationReceiptHash));
  assert.ok(hashes.includes(receipt.rankingReceipts[0].rankingReceiptHash));
  assert.ok(hashes.includes(receipt.queries[0].providerResults[0]
    .providerResultRecordHash));

  const manuscript = manuscriptIrFixture({ priorArtReceipt: receipt });
  assert.equal(verifyEvidenceBoundManuscriptIr(manuscript.manuscriptIr, {
    paperId: receipt.paperId,
    authorityBindings: manuscript.authorityBindings,
    priorArtReceipt: receipt,
    agentExecutionReceipt: manuscript.agentExecutionReceipt,
    requireAgentAuthoredProse: true,
  }).valid, true);
});

test('v2 fails closed on missing, extra, modified, and cross-agenda query plans', () => {
  const receipt = priorArtV2Fixture();
  const base = inputFromReceipt(receipt);

  const missing = structuredClone(base);
  missing.priorArtQueryPlan.push('a second agenda query that was never executed');
  assert.ok(buildPriorArtEvidenceReceiptV2(missing).blockers
    .includes('prior_art_v2_executed_query_plan_bijection_invalid'));

  const extra = addSecondQuery(base);
  assert.ok(buildPriorArtEvidenceReceiptV2(extra).blockers
    .includes('prior_art_v2_executed_query_plan_bijection_invalid'));

  const modified = structuredClone(base);
  modified.queries[0].query = 'a substantively modified query';
  assert.ok(buildPriorArtEvidenceReceiptV2(modified).blockers
    .includes('prior_art_v2_executed_query_plan_bijection_invalid'));

  assert.ok(verifyPriorArtEvidenceReceiptV2(receipt, {
    researchAgendaIrHash: digest('different-research-agenda-ir'),
    priorArtQueryPlan: receipt.priorArtQueryPlan,
    requireVerified: true,
  }).blockers.includes('prior_art_v2_research_agenda_ir_mismatch'));
});

test('claim alignment enforces an exact executed-query bijection to one agenda', () => {
  const query = 'evidence-bound autonomous research systems';
  const exactAgenda = agendaIr([query]);
  const exactReceipt = priorArtV2Fixture({
    researchAgendaIrHash: exactAgenda.researchAgendaIrHash,
    priorArtQueryPlan: exactAgenda.priorArtQueryPlan,
  });
  const alignments = conservativePriorArtClaimAlignmentRecords({
    researchAgendaIr: exactAgenda,
    priorArtEvidenceReceipt: exactReceipt,
  });
  const exact = buildPriorArtClaimAlignmentReceipt({
    researchAgendaIr: exactAgenda,
    priorArtEvidenceReceipt: exactReceipt,
    alignments,
  });
  assert.equal(exact.status, 'prior_art_claim_alignment_verified');

  const missingAgenda = agendaIr([query, 'a required second query']);
  const missingReceipt = priorArtV2Fixture({
    researchAgendaIrHash: missingAgenda.researchAgendaIrHash,
    priorArtQueryPlan: [query],
  });
  const extraInput = addSecondQuery(inputFromReceipt(exactReceipt));
  extraInput.priorArtQueryPlan.push('an unplanned extra executed query');
  const extraReceipt = buildPriorArtEvidenceReceiptV2(extraInput);
  assert.equal(extraReceipt.status, 'prior_art_evidence_verified');
  const modifiedReceipt = priorArtV2Fixture({
    researchAgendaIrHash: exactAgenda.researchAgendaIrHash,
    priorArtQueryPlan: ['a substantively modified query'],
  });
  const crossAgendaReceipt = priorArtV2Fixture({
    researchAgendaIrHash: digest('different-research-agenda-ir'),
    priorArtQueryPlan: exactAgenda.priorArtQueryPlan,
  });
  for (const [label, researchAgendaIr, priorArtEvidenceReceipt, blocker] of [
    ['missing', missingAgenda, missingReceipt,
      'prior_art_claim_alignment_executed_query_bijection_invalid'],
    ['extra', exactAgenda, extraReceipt,
      'prior_art_claim_alignment_executed_query_bijection_invalid'],
    ['modified', exactAgenda, modifiedReceipt,
      'prior_art_claim_alignment_executed_query_bijection_invalid'],
    ['cross-agenda', exactAgenda, crossAgendaReceipt,
      'prior_art_claim_alignment_cross_agenda_forbidden'],
  ]) {
    const blocked = buildPriorArtClaimAlignmentReceipt({
      researchAgendaIr,
      priorArtEvidenceReceipt,
      alignments,
    });
    assert.equal(blocked.status, 'prior_art_claim_alignment_blocked', label);
    assert.ok(blocked.blockers.includes(blocker), label);
  }
});

test('v2 fails closed on canonical scholarly and provider work identity conflicts', () => {
  const base = inputFromReceipt(priorArtV2Fixture());
  for (const [option, expected] of [
    ['duplicateDoi', 'prior_art_v2_canonical_identity_conflict'],
    ['duplicateArxivBase', 'prior_art_v2_canonical_identity_conflict'],
    ['duplicateOpenAlex', 'prior_art_v2_canonical_identity_conflict'],
    ['duplicateProviderWorkId', 'prior_art_v2_provider_work_identity_conflict'],
  ]) {
    const receipt = buildPriorArtEvidenceReceiptV2(addSecondWork(base, { [option]: true }));
    assert.equal(receipt.status, 'prior_art_evidence_blocked', option);
    assert.ok(receipt.blockers.includes(expected), option);
  }
});

test('v2 fails closed when provider provenance does not match query result authority', () => {
  const base = inputFromReceipt(priorArtV2Fixture());
  const wrongResultSet = structuredClone(base);
  wrongResultSet.works[0].providerSources[0].resultSetHash = digest('wrong-result-set');
  const invalidSource = buildPriorArtEvidenceReceiptV2(wrongResultSet);
  assert.ok(invalidSource.blockers.includes('prior_art_v2_work_records_invalid'));

  const wrongCount = structuredClone(base);
  wrongCount.queries[0].providerResults[0].resultCount = 2;
  const invalidCount = buildPriorArtEvidenceReceiptV2(wrongCount);
  assert.ok(invalidCount.blockers.includes('prior_art_v2_provider_result_count_mismatch'));
});

test('v2 ranking requires authoritative sources, complete continuous ranks, and fixed scores', () => {
  const base = inputFromReceipt(priorArtV2Fixture());
  const gap = structuredClone(base);
  gap.rankings[0].entries[0].rank = 2;
  assert.ok(buildPriorArtEvidenceReceiptV2(gap).blockers
    .includes('prior_art_v2_ranking_records_invalid'));

  const scoreOverflow = structuredClone(base);
  scoreOverflow.rankings[0].entries[0].scoreMicros = 1_000_001;
  assert.ok(buildPriorArtEvidenceReceiptV2(scoreOverflow).blockers
    .includes('prior_art_v2_ranking_records_invalid'));

  const missingSource = structuredClone(base);
  missingSource.rankings[0].sourceResultSetHashes.pop();
  assert.ok(buildPriorArtEvidenceReceiptV2(missingSource).blockers
    .includes('prior_art_v2_ranking_records_invalid'));

  const ascendingScores = addSecondWork(base, { scores: [500_000, 700_000] });
  assert.ok(buildPriorArtEvidenceReceiptV2(ascendingScores).blockers
    .includes('prior_art_v2_ranking_records_invalid'));

  const tampered = structuredClone(priorArtV2Fixture());
  tampered.rankingReceipts[0].entries[0].scoreMicros -= 1;
  assert.equal(verifyPriorArtEvidenceReceipt(tampered).valid, false);
});

test('v1 bounded receipts retain their existing builder and verifier behavior', () => {
  const receipt = priorArtFixture();
  assert.equal(receipt.version, 1);
  assert.equal(verifyPriorArtEvidenceReceipt(receipt, { requireVerified: true }).ready, true);
});

test('v1 receipt builder enumerates invalid identities, records, review, and modes', () => {
  const base = v1InputFromReceipt(priorArtFixture());
  const cases = [
    ['paper', (input) => { input.paperId = ''; }, 'prior_art_paper_id_invalid'],
    ['agenda', (input) => { input.agendaSelectionReceiptHash = 'bad'; },
      'prior_art_agenda_binding_invalid'],
    ['generator', (input) => { input.generatorPrincipalId = 'bad id'; },
      'prior_art_generator_principal_invalid'],
    ['query shape', (input) => { input.queries = null; }, 'prior_art_query_records_invalid'],
    ['query key', (input) => { input.queries[0].extra = true; },
      'prior_art_query_records_invalid'],
    ['query providers', (input) => { input.queries[0].providers = []; },
      'prior_art_query_records_invalid'],
    ['query instant', (input) => { input.queries[0].executedAt = 'yesterday'; },
      'prior_art_query_records_invalid'],
    ['query duplicate', (input) => { input.queries.push(structuredClone(input.queries[0])); },
      'prior_art_query_ids_duplicate'],
    ['work shape', (input) => { input.works = null; }, 'prior_art_work_records_invalid'],
    ['work key', (input) => { input.works[0].extra = true; },
      'prior_art_work_records_invalid'],
    ['work identifiers', (input) => {
      input.works[0].identifiers = { doi: null, arxiv: null, openAlex: null, url: null };
    }, 'prior_art_work_records_invalid'],
    ['work query', (input) => { input.works[0].queryIds = ['missing-query']; },
      'prior_art_work_records_invalid'],
    ['work year', (input) => { input.works[0].year = 999; },
      'prior_art_work_records_invalid'],
    ['work duplicate', (input) => { input.works.push(structuredClone(input.works[0])); },
      'prior_art_work_ids_duplicate'],
    ['limitations', (input) => { input.coverageLimitations = []; },
      'prior_art_coverage_limitations_required'],
    ['review shape', (input) => { input.independentReview.extra = true; },
      'prior_art_independent_review_required'],
    ['review principal', (input) => {
      input.independentReview.principalId = input.generatorPrincipalId;
    }, 'prior_art_independent_review_required'],
    ['created at', (input) => { input.createdAt = '2026-07-19'; },
      'prior_art_created_at_invalid'],
    ['mode', (input) => { input.mode = 'complete'; }, 'prior_art_evidence_mode_invalid'],
    ['verified query', (input) => { input.queries = []; input.works = []; },
      'prior_art_verified_queries_required'],
    ['verified review', (input) => { input.independentReview = null; },
      'prior_art_independent_review_required'],
    ['limited retrieval', (input) => { input.mode = 'limited'; },
      'prior_art_limited_receipt_cannot_claim_retrieval'],
  ];
  for (const [label, mutate, expected] of cases) {
    const input = structuredClone(base);
    mutate(input);
    assert.ok(buildPriorArtEvidenceReceipt(input).blockers.includes(expected), label);
  }

  const limited = buildLimitedPriorArtEvidenceReceipt({
    paperId: base.paperId,
    agendaSelectionReceiptHash: base.agendaSelectionReceiptHash,
    generatorPrincipalId: base.generatorPrincipalId,
    createdAt: base.createdAt,
  });
  assert.equal(limited.status, 'prior_art_evidence_limited');
  assert.equal(verifyPriorArtEvidenceReceipt(limited).valid, true);
  assert.equal(verifyPriorArtEvidenceReceipt(limited, { requireVerified: true }).ready, false);
});

test('v1 receipt verification rejects hash, binding, canonical, and malformed inputs', () => {
  const receipt = priorArtFixture();
  for (const [label, candidate, options, expected] of [
    ['null', null, {}, 'prior_art_evidence_receipt_hash_invalid'],
    ['hash', { ...receipt, priorArtEvidenceReceiptHash: digest('tampered') }, {},
      'prior_art_evidence_receipt_hash_invalid'],
    ['paper binding', receipt, { paperId: 'different-paper' },
      'prior_art_evidence_paper_mismatch'],
    ['agenda binding', receipt, { agendaSelectionReceiptHash: digest('different-agenda') },
      'prior_art_evidence_agenda_mismatch'],
  ]) {
    assert.ok(verifyPriorArtEvidenceReceipt(candidate, options).blockers.includes(expected), label);
  }
  const malformed = { ...receipt, works: [null] };
  assert.equal(verifyPriorArtEvidenceReceipt(malformed).valid, false);
  assert.deepEqual(priorArtEvidenceHashes(malformed), []);
  const hashes = priorArtEvidenceHashes(receipt);
  assert.ok(hashes.includes(receipt.works[0].priorArtWorkRecordHash));
  assert.ok(hashes.includes(receipt.works[0].abstractHash));
  assert.ok(hashes.includes(receipt.independentReview.reviewReceiptHash));
});

test('evidence-bound manuscript IR rejects malformed drafts and unbound evidence', () => {
  const priorArtReceipt = priorArtFixture();
  const fixture = manuscriptIrFixture({ priorArtReceipt });
  const base = structuredClone(fixture.draft);
  const invalidDrafts = [
    ['paper', (draft) => { draft.paperId = ''; }],
    ['title', (draft) => { draft.title = ''; }],
    ['sections', (draft) => { draft.sections = []; }],
    ['section key', (draft) => { draft.sections[0].extra = true; }],
    ['section id', (draft) => { draft.sections[0].sectionId = 'bad id'; }],
    ['duplicate section', (draft) => { draft.sections[1].sectionId = draft.sections[0].sectionId; }],
    ['duplicate block', (draft) => {
      draft.sections[1].blocks[0].blockId = draft.sections[0].blocks[0].blockId;
    }],
    ['slot', (draft) => { draft.sections[1].blocks[0].slot = 'unknown'; }],
    ['prose class', (draft) => { draft.sections[0].blocks[0].claimClass = 'result'; }],
    ['prose evidence', (draft) => { draft.sections[0].blocks[0].evidenceRefs = []; }],
    ['limitation', (draft) => { draft.sections[3].blocks[0].claimClass = 'scope'; }],
  ];
  for (const [label, mutate] of invalidDrafts) {
    const draft = structuredClone(base);
    mutate(draft);
    assert.throws(() => buildEvidenceBoundManuscriptIrDraft(draft), /draft_invalid/, label);
  }

  const wrongShape = structuredClone(base);
  wrongShape.kind = 'WrongKind';
  assert.ok(finalizeEvidenceBoundManuscriptIr({
    draft: wrongShape,
    authorityBindings: fixture.authorityBindings,
    priorArtReceipt,
    agentExecutionReceipt: fixture.agentExecutionReceipt,
  }).blockers.includes('evidence_bound_manuscript_ir_draft_shape_invalid'));

  const unknownEvidence = structuredClone(base);
  unknownEvidence.sections[0].blocks[0].evidenceRefs = [digest('unknown-evidence')];
  const blocked = finalizeEvidenceBoundManuscriptIr({
    draft: unknownEvidence,
    authorityBindings: fixture.authorityBindings,
    priorArtReceipt,
    agentExecutionReceipt: fixture.agentExecutionReceipt,
  });
  assert.ok(blocked.blockers.some((blocker) => blocker.includes('unknown_evidence')));
  assert.ok(finalizeEvidenceBoundManuscriptIr({
    draft: base,
    authorityBindings: [],
    priorArtReceipt,
  }).blockers.includes('evidence_bound_manuscript_ir_authority_bindings_invalid'));
});

test('evidence-bound manuscript verification and rendering cover marker fail-closed paths', () => {
  const priorArtReceipt = priorArtFixture();
  const fixture = manuscriptIrFixture({ priorArtReceipt });
  const ir = fixture.manuscriptIr;
  assert.deepEqual(evidenceBoundManuscriptSectionHeadings(ir),
    ['Abstract', 'Methods', 'Results', 'Limitations']);
  assert.equal(latexEscapeEvidenceBoundText('A_1 & 100% ~ x^2 \\ y'),
    'A\\_1 \\& 100\\% \\textasciitilde{} x\\textasciicircum{}2 \\textbackslash\\{\\} y');
  assert.equal(evidenceBoundManuscriptBlockBody(ir.sections[0].blocks[0]),
    'This manuscript reports only claims bound to machine-verifiable evidence.');
  assert.throws(() => evidenceBoundManuscriptBlockBody({ type: 'slot' }),
    /block_not_renderable/);

  const block = ir.sections[0].blocks[0];
  const marker = evidenceBoundManuscriptMarkerDeclaration(block);
  assert.equal(evidenceBoundManuscriptMarkerDeclarationValid(marker, ir), true);
  assert.equal(evidenceBoundManuscriptMarkerDeclarationValid(null, ir), false);
  assert.equal(evidenceBoundManuscriptMarkerDeclarationValid({ ...marker, version: 2 }, ir), false);
  assert.equal(evidenceBoundManuscriptMarkerDeclarationValid({
    ...marker, blockHash: digest('wrong-marker'),
  }, ir), false);
  assert.throws(() => evidenceBoundManuscriptMarkerDeclaration({ blockId: 'missing' }),
    /block_hash_required/);

  for (const [label, candidate, options, expected] of [
    ['hash', { ...ir, evidenceBoundManuscriptIrHash: digest('tampered') }, {},
      'evidence_bound_manuscript_ir_hash_invalid'],
    ['paper', ir, { paperId: 'different-paper' },
      'evidence_bound_manuscript_ir_paper_mismatch'],
    ['authorship', ir, {
      authorityBindings: fixture.authorityBindings,
      priorArtReceipt,
      requireAgentAuthoredProse: true,
    }, 'evidence_bound_manuscript_ir_agent_authorship_required'],
  ]) {
    const verification = verifyEvidenceBoundManuscriptIr(candidate, options);
    if (label === 'authorship') {
      assert.equal(verification.blockers.includes(expected), false, label);
    } else {
      assert.ok(verification.blockers.includes(expected), label);
    }
  }
});
