import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  fullResearchQualificationSigningPayloadHash,
  verifyFullResearchQualificationReceiptEnvelope,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {
  buildPriorArtEvidenceReceipt,
  buildPriorArtEvidenceReceiptV2,
  verifyPriorArtEvidenceReceipt,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';

const ISSUED_AT = '2026-07-15T08:00:00.000Z';
const NOW = new Date('2026-07-15T09:00:00.000Z');
const PRIOR_ART_BLOCKER =
  'external_qualification_independent_hypothesis_prior_art_qualification_invalid';
const HASH = (label) => hashRecord('FullResearchQualificationPriorArtLineageTestHash', {
  label,
});

function priorArtV2({
  paperId = 'paper-prior-art-lineage',
  agendaSelectionReceiptHash = HASH('agenda'),
  researchAgendaIrHash = HASH('research-agenda-ir'),
  priorArtQueryPlan = ['current exact prior-art query'],
  signatureVerificationReceiptHash = HASH('review-signature'),
} = {}) {
  const query = priorArtQueryPlan[0];
  const resultSetHash = HASH(`result-set:${query}`);
  return buildPriorArtEvidenceReceiptV2({
    paperId,
    agendaSelectionReceiptHash,
    researchAgendaIrHash,
    priorArtQueryPlan,
    generatorPrincipalId: 'prior-art-generator',
    queries: [{
      queryId: 'query-1',
      query,
      executedAt: ISSUED_AT,
      providerResults: [{
        providerId: 'prior-art-provider',
        providerQueryId: 'provider-query-1',
        corpusSnapshotHash: HASH(`corpus:${query}`),
        resultSetHash,
        retrievalReceiptHash: HASH(`retrieval:${query}`),
        resultCount: 1,
      }],
    }],
    works: [{
      workId: 'work-1',
      title: 'Current prior-art work',
      authors: ['Independent Author'],
      year: 2025,
      identifiers: {
        doi: '10.0000/prior-art-lineage',
        arxiv: null,
        openAlex: null,
        url: null,
      },
      abstractHash: HASH('abstract'),
      providerSources: [{
        providerId: 'prior-art-provider',
        providerWorkId: 'provider-work-1',
        queryId: 'query-1',
        resultSetHash,
        sourceSnapshotHash: HASH(`source:${query}`),
      }],
    }],
    deduplication: {
      algorithmId: 'exact-identity-deduplication',
      algorithmVersion: 'v1',
      algorithmConfigurationHash: HASH('deduplication-configuration'),
    },
    rankings: [{
      queryId: 'query-1',
      algorithmId: 'bounded-ranking',
      algorithmVersion: 'v1',
      algorithmConfigurationHash: HASH('ranking-configuration'),
      sourceResultSetHashes: [resultSetHash],
      entries: [{ workId: 'work-1', rank: 1, scoreMicros: 900_000 }],
    }],
    coverageLimitations: [
      'Finite configured corpora do not establish open-world completeness.',
    ],
    independentReview: {
      principalId: 'prior-art-reviewer',
      providerAccountIdentityHash: HASH('reviewer-account'),
      trustDomainIdentityHash: HASH('reviewer-domain'),
      reviewReceiptHash: HASH('review'),
      signatureVerificationReceiptHash,
      independentFromGenerator: true,
    },
    createdAt: ISSUED_AT,
    mode: 'verified',
  });
}

function legacyPriorArtV1({ paperId, agendaSelectionReceiptHash }) {
  const query = 'current exact prior-art query';
  return buildPriorArtEvidenceReceipt({
    paperId,
    agendaSelectionReceiptHash,
    generatorPrincipalId: 'prior-art-generator',
    queries: [{
      queryId: 'query-1',
      query,
      providers: ['prior-art-provider'],
      executedAt: ISSUED_AT,
      corpusSnapshotHash: HASH('legacy-corpus'),
      resultSetHash: HASH('legacy-results'),
      retrievalReceiptHash: HASH('legacy-retrieval'),
    }],
    works: [{
      workId: 'work-1',
      title: 'Legacy prior-art work',
      authors: ['Independent Author'],
      year: 2025,
      identifiers: {
        doi: '10.0000/prior-art-lineage',
        arxiv: null,
        openAlex: null,
        url: null,
      },
      queryIds: ['query-1'],
      sourceSnapshotHash: HASH('legacy-source'),
      abstractHash: HASH('abstract'),
    }],
    coverageLimitations: [
      'Finite configured corpora do not establish open-world completeness.',
    ],
    independentReview: {
      principalId: 'prior-art-reviewer',
      providerAccountIdentityHash: HASH('reviewer-account'),
      trustDomainIdentityHash: HASH('reviewer-domain'),
      reviewReceiptHash: HASH('review'),
      signatureVerificationReceiptHash: HASH('legacy-review-signature'),
      independentFromGenerator: true,
    },
    createdAt: ISSUED_AT,
    mode: 'verified',
  });
}

function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'prior-art-lineage-key',
    keyVersion: 'v1',
    subjectId: 'prior-art-lineage-attestor',
    organization: 'prior-art-lineage-office',
    role: 'research_execution_release_attestor',
    algorithm: 'ed25519',
  });
  const paperId = 'paper-prior-art-lineage';
  const campaignId = 'campaign-prior-art-lineage';
  const campaignPlanHash = HASH('campaign-plan');
  const campaignReleaseBundleHash = HASH('campaign-release');
  const agendaSelectionReceiptHash = HASH('agenda');
  const researchAgendaIrHash = HASH('research-agenda-ir');
  const priorArtQueryPlan = Object.freeze(['current exact prior-art query']);
  const currentPriorArtEvidenceReceipt = priorArtV2({
    paperId,
    agendaSelectionReceiptHash,
    researchAgendaIrHash,
    priorArtQueryPlan,
  });
  const bindingPayload = {
    version: 4,
    kind: 'AutonomousResearchReleaseBinding',
    campaignId,
    paperId,
    campaignPlanHash,
    proposalHash: HASH('proposal'),
    policyAuthorizationHash: HASH('policy'),
    seedBindingHash: HASH('seed'),
    proposal: { agendaSelectionReceiptHash },
    researchAgendaIrHash,
    researchAgendaIr: { researchAgendaIrHash, priorArtQueryPlan },
    priorArtEvidenceReceiptHash:
      currentPriorArtEvidenceReceipt.priorArtEvidenceReceiptHash,
    priorArtEvidenceReceipt: currentPriorArtEvidenceReceipt,
  };
  const releaseBinding = Object.freeze({
    ...bindingPayload,
    autonomousResearchReleaseBindingHash:
      hashRecord('AutonomousResearchReleaseBinding', bindingPayload),
  });
  const authority = Object.freeze({
    status: 'current_completed_release',
    campaignStatus: 'completed',
    packageNodeStatus: 'completed',
    campaignId,
    paperId,
    campaignReleaseBundleHash,
    releaseBundle: Object.freeze({
      campaignPlanHash,
      campaignReleaseBundleHash,
      autonomousResearchReleaseBindingHash:
        releaseBinding.autonomousResearchReleaseBindingHash,
      autonomousResearchReleaseBinding: releaseBinding,
      researchReport: {
        promotionEligibility: { status: 'research_promotion_ready' },
      },
    }),
  });
  const sign = (selectedPriorArtEvidenceReceipt, {
    includePriorArtEvidenceReceipt = true,
  } = {}) => {
    const unsigned = {
      version: 1,
      kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
      status: 'full_research_golden_micro_campaign_qualified',
      campaignId,
      paperId,
      campaignReleaseBundleHash,
      proposalHash: releaseBinding.proposalHash,
      policyAuthorizationHash: releaseBinding.policyAuthorizationHash,
      seedBindingHash: releaseBinding.seedBindingHash,
      independentHypothesisPriorArtReviewVerified: true,
      independentHypothesisPriorArtReceiptHash:
        selectedPriorArtEvidenceReceipt?.priorArtEvidenceReceiptHash
        || currentPriorArtEvidenceReceipt.priorArtEvidenceReceiptHash,
      ...(includePriorArtEvidenceReceipt
        ? { priorArtEvidenceReceipt: selectedPriorArtEvidenceReceipt }
        : {}),
      signer,
      issuedAt: ISSUED_AT,
      expiresAt: '2026-07-16T08:00:00.000Z',
      externalActionPerformed: true,
    };
    const signingPayloadHash = fullResearchQualificationSigningPayloadHash(unsigned);
    const signature = crypto.sign(
      null,
      Buffer.from(signingPayloadHash, 'utf8'),
      pair.privateKey,
    ).toString('base64');
    const signed = { ...unsigned, signature };
    return Object.freeze({
      ...signed,
      fullResearchQualificationReceiptHash: hashRecord(
        'FullResearchGoldenMicroCampaignQualificationReceipt',
        signed,
      ),
    });
  };
  const verifyQualificationSignature = ({
    signingPayloadHash, signature, signer: observedSigner, signedAt,
  } = {}) => {
    try {
      return JSON.stringify(observedSigner) === JSON.stringify(signer)
        && signedAt === ISSUED_AT
        && crypto.verify(
          null,
          Buffer.from(signingPayloadHash, 'utf8'),
          pair.publicKey,
          Buffer.from(signature, 'base64'),
        );
    } catch {
      return false;
    }
  };
  const verify = (receipt) => verifyFullResearchQualificationReceiptEnvelope(receipt, {
    now: NOW,
    campaignReleaseAuthority: authority,
    expectedPaperId: paperId,
    expectedProposalHash: releaseBinding.proposalHash,
    expectedPolicyAuthorizationHash: releaseBinding.policyAuthorizationHash,
    expectedSeedBindingHash: releaseBinding.seedBindingHash,
    verifyQualificationSignature,
    allowBoundedGoldenCapability: false,
  });
  return Object.freeze({
    agendaSelectionReceiptHash,
    currentPriorArtEvidenceReceipt,
    paperId,
    priorArtQueryPlan,
    releaseBinding,
    researchAgendaIrHash,
    sign,
    verify,
  });
}

test('qualification accepts only the current canonical v2 prior-art lineage', () => {
  const f = fixture();
  const canonicalVerification = verifyPriorArtEvidenceReceipt(
    f.currentPriorArtEvidenceReceipt,
    {
      paperId: f.paperId,
      agendaSelectionReceiptHash: f.agendaSelectionReceiptHash,
      researchAgendaIrHash: f.researchAgendaIrHash,
      priorArtQueryPlan: f.priorArtQueryPlan,
      priorArtQueryPlanHash:
        f.currentPriorArtEvidenceReceipt.priorArtQueryPlanHash,
      requireVerified: true,
    },
  );
  assert.equal(canonicalVerification.ready, true, canonicalVerification.blockers.join(','));

  const result = f.verify(f.sign(f.currentPriorArtEvidenceReceipt));
  assert.equal(result.signatureVerified, true, JSON.stringify(result.blockers));
  assert.equal(result.blockers.includes(PRIOR_ART_BLOCKER), false);
});

test('qualification rejects authentic same-paper prior-art lineage splices', () => {
  const f = fixture();
  const cases = [
    ['different-agenda', priorArtV2({
      paperId: f.paperId,
      agendaSelectionReceiptHash: HASH('different-agenda'),
      researchAgendaIrHash: f.researchAgendaIrHash,
      priorArtQueryPlan: f.priorArtQueryPlan,
    })],
    ['different-research-agenda-ir', priorArtV2({
      paperId: f.paperId,
      agendaSelectionReceiptHash: f.agendaSelectionReceiptHash,
      researchAgendaIrHash: HASH('different-research-agenda-ir'),
      priorArtQueryPlan: f.priorArtQueryPlan,
    })],
    ['different-query-plan', priorArtV2({
      paperId: f.paperId,
      agendaSelectionReceiptHash: f.agendaSelectionReceiptHash,
      researchAgendaIrHash: f.researchAgendaIrHash,
      priorArtQueryPlan: ['attacker-selected prior-art query'],
    })],
    ['different-receipt-hash', priorArtV2({
      paperId: f.paperId,
      agendaSelectionReceiptHash: f.agendaSelectionReceiptHash,
      researchAgendaIrHash: f.researchAgendaIrHash,
      priorArtQueryPlan: f.priorArtQueryPlan,
      signatureVerificationReceiptHash: HASH('different-review-signature'),
    })],
  ];
  for (const [label, donor] of cases) {
    assert.deepEqual(donor.blockers, [], `${label} donor must be canonical`);
    const result = f.verify(f.sign(donor));
    assert.equal(result.signatureVerified, true, label);
    assert.ok(result.blockers.includes(PRIOR_ART_BLOCKER), label);
  }
});

test('qualification rejects signed hash-only and canonical legacy-v1 evidence', () => {
  const f = fixture();
  const hashOnly = f.verify(f.sign(
    f.currentPriorArtEvidenceReceipt,
    { includePriorArtEvidenceReceipt: false },
  ));
  assert.ok(hashOnly.blockers.includes(PRIOR_ART_BLOCKER));

  const legacy = legacyPriorArtV1({
    paperId: f.paperId,
    agendaSelectionReceiptHash: f.agendaSelectionReceiptHash,
  });
  assert.deepEqual(legacy.blockers, []);
  const legacyResult = f.verify(f.sign(legacy));
  assert.equal(legacyResult.signatureVerified, true);
  assert.ok(legacyResult.blockers.includes(PRIOR_ART_BLOCKER));
});
