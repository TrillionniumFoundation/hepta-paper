import assert from 'node:assert/strict';
import test from 'node:test';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildEvidenceBoundManuscriptIrDraft,
  finalizeEvidenceBoundManuscriptIr,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  buildEvidenceEntailmentContract,
  verifyEvidenceEntailmentContract,
} from '../../paper-domain/research/evidence-entailment-contract.mjs';
import {
  buildEvidenceEntailmentSourceDocument,
} from '../../paper-domain/research/evidence-entailment-source-document.mjs';
import {
  autonomousManuscriptEvidenceRefBindings,
  autonomousManuscriptEvidenceSourceDocuments,
} from '../../paper-adapters/automation/autonomous-manuscript-ir-materialization.mjs';
import {
  buildIndependentEvidenceEntailmentReviewReceipt,
  verifyIndependentEvidenceEntailmentReviewReceipt,
} from '../../paper-domain/research/evidence-entailment-review-receipt-contract.mjs';
import {
  evaluateManuscriptPromotion,
} from '../../paper-domain/quality/manuscript-promotion-gate.mjs';
import {
  manuscriptPromotionEvidenceEntailmentValid,
} from '../../paper-domain/research/manuscript-promotion-entailment-release-policy.mjs';

const H = (value) => hashBytes(Buffer.from(String(value), 'utf8'));
const PAPER_ID = 'paper-entailment-closed-loop';
const MANUSCRIPT_HASH = H('rendered-manuscript');

test('autonomous manuscript evidence normalizes integrated formal receipts and exact replay records', () => {
  const replayPayload = {
    version: 1,
    kind: 'FormalCertificateReplayReceipt',
    status: 'formal_claim_replay_verified',
    theoremName: 'boundedClaim',
    expectedTypeHash: H('expected-type'),
    replayTypeHash: H('expected-type'),
    axiomAuditPassed: true,
    externalActionPerformed: false,
  };
  const replayReceipt = {
    ...replayPayload,
    formalCertificateReplayReceiptHash:
      hashRecord('FormalCertificateReplayReceipt', replayPayload),
  };
  const replayWrapper = {
    version: 1,
    kind: 'FormalCertificateBundle',
    formalCertificateReplayReceiptHash:
      replayReceipt.formalCertificateReplayReceiptHash,
    replayReceipt,
  };
  const formalPayload = {
    version: 1,
    kind: 'CampaignFormalVerificationReceipt',
    status: 'campaign_formal_verification_completed',
    blockers: [],
    formalWorkerReceiptHashes: [H('formal-worker')],
    formalReplayReceiptHashes: [replayReceipt.formalCertificateReplayReceiptHash],
    certificateBundle: replayWrapper,
    externalActionPerformed: false,
  };
  const formalVerificationReceipt = {
    ...formalPayload,
    campaignFormalVerificationReceiptHash:
      hashRecord('CampaignFormalVerificationReceipt', formalPayload),
    workspaceAttemptIntegration: {
      version: 1,
      kind: 'WorkspaceAttemptIntegrationDescriptor',
      workspaceAttemptIntegrationDescriptorHash: H('integration'),
    },
  };
  const documents = autonomousManuscriptEvidenceSourceDocuments({
    formalVerificationReceipt,
  });
  assert.deepEqual(
    documents.map((document) => document.evidenceKind).sort(),
    ['formal_kernel_replay', 'formal_verification'],
  );
  assert.equal(documents.find(
    (document) => document.evidenceKind === 'formal_verification',
  )?.evidenceHash, formalVerificationReceipt.campaignFormalVerificationReceiptHash);
  assert.equal(documents.find(
    (document) => document.evidenceKind === 'formal_kernel_replay',
  )?.evidenceHash, replayReceipt.formalCertificateReplayReceiptHash);
  assert.deepEqual(autonomousManuscriptEvidenceRefBindings({
    formalVerificationReceipt,
  }), [{
    kind: 'formal_verification',
    hash: formalVerificationReceipt.campaignFormalVerificationReceiptHash,
    claimClasses: ['interpretation', 'limitation', 'reproducibility'],
  }]);
  assert.throws(() => autonomousManuscriptEvidenceSourceDocuments({
    formalVerificationReceipt: {
      ...formalVerificationReceipt,
      status: 'campaign_formal_verification_blocked',
    },
  }), /evidence_entailment_source_document_hash_invalid/);
});

function manuscriptFixture() {
  const proposalPayload = {
    version: 1,
    kind: 'MachineProposedScientificClaimSet',
    status: 'machine_scientific_claim_set_proposed',
    paperId: PAPER_ID,
    objective: 'Evaluate a bounded registered protocol.',
    protocolFamily: 'machine_learning',
    claimAuthorityType: 'machine-proposed-untrusted',
    claims: [{ statement: 'A bounded empirical claim.' }],
    limitations: {
      scientificNoveltyVerified: false,
      scientificCorrectnessVerified: false,
      formalProofVerified: false,
      empiricalResultVerified: false,
      universalResearchValidityClaimed: false,
      naturalLanguageToLeanEquivalenceMachineProven: false,
    },
  };
  const proposal = {
    ...proposalPayload,
    machineProposedScientificClaimSetHash:
      hashRecord('MachineProposedScientificClaimSet', proposalPayload),
  };
  const policyPayload = {
    version: 1,
    kind: 'AutonomousResearchPolicyAuthorization',
    status: 'machine_proposal_policy_authorized',
    decision: 'authorize_bounded_research_execution',
    claimAuthorityType: 'machine-policy-authorized',
    protocolFamily: 'machine_learning',
    requestedRevisionRounds: 3,
    requestedRefereeCount: 2,
    dataScope: {
      humanSubjects: false,
      privateData: false,
      externalDatasetAuthorityVerified: true,
    },
    safety: {
      scientificNoveltyVerified: false,
      scientificCorrectnessVerified: false,
      universalResearchValidityClaimed: false,
      naturalLanguageToLeanEquivalenceMachineProven: false,
      externalSubmissionAuthorized: false,
      externalReleaseAttestationRequired: true,
    },
  };
  const policy = {
    ...policyPayload,
    autonomousResearchPolicyAuthorizationHash:
      hashRecord('AutonomousResearchPolicyAuthorization', policyPayload),
  };
  const result = {
    accepted: true,
    adjustedPValue: 0.02,
    assumptionAccepted: true,
    bootstrapLower: 0.12,
    bootstrapUpper: 0.31,
    count: 32,
    estimate: 0.22,
    holmRank: 1,
    holmThreshold: 0.05,
    minimumLeaveOneOutMean: 0.19,
    multiplicityAccepted: true,
    pValue: 0.01,
    sensitivityAccepted: true,
    skewness: 0.1,
    standardDeviation: 0.4,
    standardError: 0.07,
    standardizedEffect: 0.55,
    uncertaintyAccepted: true,
    winsorizedMean: 0.21,
    scientificVerdict: 'positive',
    scientificUncertaintyReasons: [],
  };
  const empiricalPayload = {
    version: 1,
    kind: 'EmpiricalAssertionAuthorityEntry',
    paperId: PAPER_ID,
    campaignId: 'campaign-entailment',
    experimentId: 'experiment-entailment',
    claimId: 'claim-entailment',
    hypothesisId: 'hypothesis-entailment',
    predicate: {
      metric: 'accuracy_delta',
      metricUnit: 'accuracy-points',
      pairedUnit: 'seed',
      comparator: 'baseline',
      alternative: 'greater',
      minimumEffect: 0.1,
      acceptanceRequired: true,
    },
    scientificVerdict: 'positive',
    verdict: 'positive',
    original: { result },
    replay: { result },
  };
  const empirical = {
    ...empiricalPayload,
    empiricalAssertionAuthorityEntryHash:
      hashRecord('EmpiricalAssertionAuthorityEntry', empiricalPayload),
  };
  const proposalHash = proposal.machineProposedScientificClaimSetHash;
  const policyHash = policy.autonomousResearchPolicyAuthorizationHash;
  const empiricalHash = empirical.empiricalAssertionAuthorityEntryHash;
  const draft = buildEvidenceBoundManuscriptIrDraft({
    paperId: PAPER_ID,
    title: 'Typed evidence entailment',
    sections: [{
      sectionId: 'abstract',
      heading: 'Abstract',
      blocks: [{
        type: 'prose',
        blockId: 'bounded-scope',
        claimClass: 'scope',
        text: 'The reported scope is bounded by the declared proposal and policy.',
        evidenceRefs: [proposalHash, policyHash],
      }],
    }, {
      sectionId: 'results',
      heading: 'Results',
      blocks: [
        {
          type: 'prose',
          blockId: 'registered-result',
          claimClass: 'interpretation',
          text: 'The registered estimate is positive in the original and replay evaluations.',
          evidenceRefs: [empiricalHash],
        },
        { type: 'slot', blockId: 'empirical-claims-slot', slot: 'empirical_claims' },
        { type: 'slot', blockId: 'formal-support-slot', slot: 'formal_support' },
        { type: 'slot', blockId: 'empirical-results-slot', slot: 'empirical_results' },
      ],
    }, {
      sectionId: 'limitations',
      heading: 'Limitations',
      blocks: [{
        type: 'prose',
        blockId: 'bounded-limitation',
        claimClass: 'limitation',
        text: 'The evidence does not establish open-world scientific truth.',
        evidenceRefs: [policyHash],
      }],
    }],
  });
  const ir = finalizeEvidenceBoundManuscriptIr({
    draft,
    authorityBindings: [
      { kind: 'policy_authorization', hash: policyHash },
      { kind: 'proposal', hash: proposalHash },
      { kind: 'empirical_assertion_authority_entry', hash: empiricalHash },
    ],
  });
  const sourceEvidenceDocuments = [
    buildEvidenceEntailmentSourceDocument({
      evidenceKind: 'proposal',
      recordHashTag: 'MachineProposedScientificClaimSet',
      recordHashField: 'machineProposedScientificClaimSetHash',
      record: proposal,
    }),
    buildEvidenceEntailmentSourceDocument({
      evidenceKind: 'policy_authorization',
      recordHashTag: 'AutonomousResearchPolicyAuthorization',
      recordHashField: 'autonomousResearchPolicyAuthorizationHash',
      record: policy,
    }),
    buildEvidenceEntailmentSourceDocument({
      evidenceKind: 'empirical_assertion_authority_entry',
      recordHashTag: 'EmpiricalAssertionAuthorityEntry',
      recordHashField: 'empiricalAssertionAuthorityEntryHash',
      record: empirical,
    }),
  ];
  return { ir, sourceEvidenceDocuments };
}

function acceptedConvergence({
  contract,
  authorPrincipalId = 'research-author',
} = {}) {
  const perClaimReview = {
    version: 1,
    kind: 'EvidenceEntailmentPerClaimReview',
    evidenceEntailmentContractHash: contract.evidenceEntailmentContractHash,
    claims: contract.claims.map((claim) => ({
      claimId: claim.claimId,
      renderedSentenceHash: claim.renderedSentenceHash,
      verdict: 'entailed',
      rationale: 'The bounded typed evidence fields support this exact sentence.',
    })),
  };
  const review = (ordinal) => {
    const unsignedPayload = {
      status: 'agent_execution_completed',
      role: 'independent-review',
      executorId: `review-executor-${ordinal}`,
      structuredOutput: { evidenceEntailmentReview: perClaimReview },
    };
    const unsignedAgentExecutionReceipt = {
      ...unsignedPayload,
      agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', unsignedPayload),
    };
    return {
      reviewerId: `reviewer-${ordinal}`,
      reviewPrincipalId: ordinal === 1 && authorPrincipalId === 'reviewer-1'
        ? authorPrincipalId : `review-principal-${ordinal}`,
      reviewerTrustDomainIdentityHash: H(`trust-domain-${ordinal}`),
      reviewHash: H(`review-${ordinal}`),
      signedReviewerReceiptHash: H(`signed-review-${ordinal}`),
      signatureVerificationReceiptHash: H(`signature-verification-${ordinal}`),
      manuscriptHash: MANUSCRIPT_HASH,
      verdict: 'accept',
      criticalFindingCount: 0,
      unsignedAgentExecutionReceiptHash:
        unsignedAgentExecutionReceipt.agentExecutionReceiptHash,
      unsignedAgentExecutionReceipt,
    };
  };
  const payload = {
    version: 2,
    kind: 'RefereeConvergenceDecision',
    paperId: PAPER_ID,
    status: 'referee_convergence_reached',
    accepted: true,
    expectedManuscriptHash: MANUSCRIPT_HASH,
    manuscriptHashBound: true,
    evidenceIdentityBound: true,
    qualityGatesPassed: true,
    requireSignedReviewerReceipts: true,
    signedReviewerReceiptsVerified: true,
    reviewSemanticEvidenceBound: true,
    reviews: [review(1), review(2)],
  };
  return Object.freeze({
    ...payload,
    refereeConvergenceDecisionHash: hashRecord('RefereeConvergenceDecision', payload),
  });
}

function closedLoop() {
  const { ir, sourceEvidenceDocuments } = manuscriptFixture();
  const contract = buildEvidenceEntailmentContract({
    manuscriptIr: ir,
    sourceEvidenceDocuments,
  });
  const receipt = buildIndependentEvidenceEntailmentReviewReceipt({
    evidenceEntailmentContract: contract,
    refereeConvergenceDecision: acceptedConvergence({ contract }),
    authorPrincipalId: 'research-author',
  });
  return { ir, contract, receipt };
}

test('typed entailment covers every rendered IR block and maps every evidence ref to a field predicate', () => {
  const { ir, contract } = closedLoop();
  const verification = verifyEvidenceEntailmentContract(contract, {
    paperId: PAPER_ID,
    evidenceBoundManuscriptIrHash: ir.evidenceBoundManuscriptIrHash,
  });
  assert.equal(verification.valid, true);
  assert.equal(contract.blockCount, 3);
  assert.equal(contract.untypedRenderedBlockCount, 0);
  assert.equal(contract.allRenderedBlocksCovered, true);
  for (const claim of contract.claims) {
    assert.equal(claim.renderedSentenceHash, H(claim.renderedSentence));
    assert.ok(claim.evidenceRefs.every((evidenceHash) => (
      claim.evidencePredicates.some((predicate) => predicate.evidenceHash === evidenceHash)
    )));
    assert.ok(claim.evidencePredicates.every((predicate) => (
      ['equals', 'array_length_equals'].includes(predicate.operator)
      && predicate.fieldPath.startsWith('/')
      && predicate.sourceDocumentHash.startsWith('sha256:')
      && predicate.sourceFactHash.startsWith('sha256:')
      && predicate.satisfied === true
    )));
  }
  const empiricalClaim = contract.claims.find((claim) => claim.blockId === 'registered-result');
  assert.ok(empiricalClaim.evidencePredicates.some((predicate) => (
    predicate.fieldPath === '/predicate/metric'
      && predicate.actualValue === 'accuracy_delta'
  )));
  assert.ok(empiricalClaim.evidencePredicates.some((predicate) => (
    predicate.fieldPath === '/original/result/bootstrapLower'
      && predicate.actualValue === 0.12
      && predicate.unit === 'accuracy-points'
      && predicate.denominator?.kind === 'observation_count'
      && predicate.denominator?.fieldPath === '/original/result/count'
      && predicate.denominator?.value === 32
  )));
  assert.ok(empiricalClaim.evidencePredicates.some((predicate) => (
    predicate.fieldPath === '/original/result/count'
      && predicate.actualValue === 32
      && predicate.unit === 'seed'
      && predicate.denominator === null
  )));
});

test('contract verification rejects a rehashed sentence that no longer matches the source IR', () => {
  const { contract } = closedLoop();
  const first = contract.claims[0];
  const { typedEvidenceEntailmentClaimHash: _claimHash, ...claimPayload } = first;
  const changedClaimPayload = {
    ...claimPayload,
    renderedSentence: 'A different unsupported sentence.',
    renderedSentenceHash: H('A different unsupported sentence.'),
  };
  const changedClaim = {
    ...changedClaimPayload,
    typedEvidenceEntailmentClaimHash:
      hashRecord('TypedEvidenceEntailmentClaim', changedClaimPayload),
  };
  const { evidenceEntailmentContractHash: _contractHash, ...contractPayload } = contract;
  const changedPayload = { ...contractPayload, claims: [changedClaim, ...contract.claims.slice(1)] };
  const changed = {
    ...changedPayload,
    evidenceEntailmentContractHash: hashRecord('EvidenceEntailmentContract', changedPayload),
  };
  const verification = verifyEvidenceEntailmentContract(changed);
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('evidence_entailment_contract_not_canonical'));
});

test('source metric tampering remains blocked after every local wrapper is rehashed', () => {
  const { contract } = closedLoop();
  const changed = structuredClone(contract);
  const document = changed.sourceEvidenceDocuments.find((candidate) => (
    candidate.evidenceKind === 'empirical_assertion_authority_entry'
  ));
  const previousDocumentHash = document.sourceDocumentHash;
  const fact = document.facts.find((candidate) => (
    candidate.fieldPath === '/original/result/estimate'
  ));
  const previousFactHash = fact.sourceFactHash;
  document.recordPayload.original.result.estimate = 999;
  fact.value = 999;
  const { sourceFactHash: _factHash, ...factPayload } = fact;
  fact.sourceFactHash = hashRecord('EvidenceEntailmentSourceFact', factPayload);
  const { sourceDocumentHash: _documentHash, ...documentPayload } = document;
  document.sourceDocumentHash = hashRecord(
    'EvidenceEntailmentSourceDocument',
    documentPayload,
  );
  for (const claim of changed.claims) {
    for (const predicate of claim.evidencePredicates) {
      if (predicate.sourceDocumentHash !== previousDocumentHash) continue;
      predicate.sourceDocumentHash = document.sourceDocumentHash;
      if (predicate.sourceFactHash === previousFactHash) {
        predicate.sourceFactHash = fact.sourceFactHash;
        predicate.expectedValue = 999;
        predicate.actualValue = 999;
      }
      const { typedEvidenceFieldPredicateHash: _predicateHash, ...predicatePayload } = predicate;
      predicate.typedEvidenceFieldPredicateHash = hashRecord(
        'TypedEvidenceFieldPredicate',
        predicatePayload,
      );
    }
    const { typedEvidenceEntailmentClaimHash: _claimHash, ...claimPayload } = claim;
    claim.typedEvidenceEntailmentClaimHash = hashRecord(
      'TypedEvidenceEntailmentClaim',
      claimPayload,
    );
  }
  changed.sourceEvidenceDocumentSetHash = hashRecord(
    'EvidenceEntailmentSourceDocumentSet',
    changed.sourceEvidenceDocuments.map((candidate) => candidate.sourceDocumentHash),
  );
  changed.blockCoverageHash = hashRecord(
    'EvidenceEntailmentBlockCoverage',
    changed.claims.map((claim) => ({
      claimId: claim.claimId,
      blockId: claim.blockId,
      manuscriptIrBlockHash: claim.manuscriptIrBlockHash,
      renderedSentenceHash: claim.renderedSentenceHash,
      evidenceRefs: claim.evidenceRefs,
      predicateHashes: claim.evidencePredicates.map((predicate) => (
        predicate.typedEvidenceFieldPredicateHash
      )),
    })),
  );
  const { evidenceEntailmentContractHash: _contractHash, ...contractPayload } = changed;
  changed.evidenceEntailmentContractHash = hashRecord(
    'EvidenceEntailmentContract',
    contractPayload,
  );
  const verification = verifyEvidenceEntailmentContract(changed);
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('evidence_entailment_source_document_set_invalid'));
});

test('claim classes reject evidence kinds that cannot support their typed provenance role', () => {
  const { ir, sourceEvidenceDocuments } = manuscriptFixture();
  const changedBindings = ir.authorityBindings.map((binding) => (
    binding.kind === 'proposal' ? { ...binding, kind: 'prior_art' } : binding
  ));
  const { evidenceBoundManuscriptIrHash: _irHash, ...irPayload } = ir;
  const changedIrPayload = {
    ...irPayload,
    authorityBindings: changedBindings,
    authorityBindingSetHash:
      hashRecord('EvidenceBoundManuscriptIRAuthorityBindings', changedBindings),
  };
  const changedIr = {
    ...changedIrPayload,
    evidenceBoundManuscriptIrHash:
      hashRecord('EvidenceBoundManuscriptIR', changedIrPayload),
  };
  const contract = buildEvidenceEntailmentContract({
    manuscriptIr: changedIr,
    sourceEvidenceDocuments,
  });
  assert.equal(contract.status, 'evidence_entailment_contract_blocked');
  assert.ok(contract.blockers.some((blocker) => (
    blocker.startsWith('evidence_entailment_evidence_kind_not_allowed:bounded-scope')
  )));
  assert.equal(verifyEvidenceEntailmentContract(contract).valid, false);
});

test('independent review receipt binds typed predicates to accepted signed reviewers separated from the author', () => {
  const { ir, contract, receipt } = closedLoop();
  const verification = verifyIndependentEvidenceEntailmentReviewReceipt(receipt, {
    paperId: PAPER_ID,
    evidenceEntailmentContractHash: contract.evidenceEntailmentContractHash,
    evidenceBoundManuscriptIrHash: ir.evidenceBoundManuscriptIrHash,
    reviewedManuscriptHash: MANUSCRIPT_HASH,
    authorPrincipalId: 'research-author',
  });
  assert.equal(verification.valid, true);
  assert.equal(receipt.semanticEntailmentReviewed, true);
  assert.equal(receipt.typedProvenancePredicatesVerified, true);
  assert.equal(receipt.typedSourceFieldPredicatesVerified, true);
  assert.equal(receipt.openWorldScientificTruthEstablished, false);

  const colliding = buildIndependentEvidenceEntailmentReviewReceipt({
    evidenceEntailmentContract: contract,
    refereeConvergenceDecision: acceptedConvergence({
      contract,
      authorPrincipalId: 'reviewer-1',
    }),
    authorPrincipalId: 'reviewer-1',
  });
  assert.equal(colliding.status, 'independent_evidence_entailment_review_blocked');
  assert.ok(colliding.blockers.includes('evidence_entailment_review_principal_separation_invalid'));

  const genericDecision = acceptedConvergence({ contract });
  const { refereeConvergenceDecisionHash: _decisionHash, ...decisionPayload } = genericDecision;
  const genericPayload = {
    ...decisionPayload,
    reviews: genericDecision.reviews.map((review) => ({
      ...review,
      unsignedAgentExecutionReceipt: null,
    })),
  };
  const genericOnly = buildIndependentEvidenceEntailmentReviewReceipt({
    evidenceEntailmentContract: contract,
    refereeConvergenceDecision: {
      ...genericPayload,
      refereeConvergenceDecisionHash:
        hashRecord('RefereeConvergenceDecision', genericPayload),
    },
    authorPrincipalId: 'research-author',
  });
  assert.equal(genericOnly.status, 'independent_evidence_entailment_review_blocked');
  assert.ok(genericOnly.blockers.includes(
    'evidence_entailment_review_per_claim_verdict_invalid',
  ));
});

test('promotion v2 fails closed without a verified independent entailment receipt', () => {
  const { ir, contract, receipt } = closedLoop();
  const common = {
    paperTask: { paperId: PAPER_ID },
    requireEvidenceEntailmentReview: true,
    expectedManuscriptHash: MANUSCRIPT_HASH,
    expectedEvidenceEntailmentContractHash: contract.evidenceEntailmentContractHash,
    expectedEvidenceBoundManuscriptIrHash: ir.evidenceBoundManuscriptIrHash,
    expectedManuscriptAuthorPrincipalId: 'research-author',
  };
  const ready = evaluateManuscriptPromotion({
    ...common,
    evidenceEntailmentReviewReceipt: receipt,
  });
  assert.equal(ready.version, 2);
  assert.equal(ready.status, 'manuscript_promotion_ready');
  assert.equal(ready.evidenceEntailmentReviewVerification.valid, true);
  assert.equal(manuscriptPromotionEvidenceEntailmentValid(ready), true);
  assert.equal(manuscriptPromotionEvidenceEntailmentValid({
    ...ready,
    independentEvidenceEntailmentReviewReceipt: null,
  }), false);

  const blocked = evaluateManuscriptPromotion(common);
  assert.equal(blocked.status, 'manuscript_promotion_blocked');
  assert.ok(blocked.blockers.includes(
    'independent_evidence_entailment_review_required_for_promotion',
  ));
});
