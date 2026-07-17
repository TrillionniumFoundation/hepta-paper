import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateFormalClaimBindings } from '../../paper-domain/research/formal-claim-binding-policy.mjs';
import { buildFormalClaimContract, manuscriptClaimHash } from '../../paper-domain/research/formal-claim-contract.mjs';
import {
  createProofObligationContracts,
  createTheoremSpecification,
  verifyTheoremSpecification,
} from '../../paper-domain/research/theorem-specification.mjs';
import {
  finalizeTheoremSpecification,
  readFinalizedTheoremSpecification,
} from '../../paper-adapters/automation/theorem-specification-finalizer.mjs';
import {
  createProposalClaimToTheoremBinding,
  verifyApprovedProposalSeedLineageAuthority,
  verifyProposalClaimToTheoremBinding,
} from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { readFormalClaimUniverse } from '../../paper-adapters/research-verify/formal-claim-universe-reader.mjs';
import { leanSourceDeclarationRecords } from '../../paper-adapters/research-verify/lean-source-contracts.mjs';
import { buildCampaignFormalReviewEnvelope } from '../../paper-adapters/automation/campaign-formal-review-envelope.mjs';
import { verifyFormalReviewAgentReceiptBinding } from '../../paper-adapters/automation/campaign-formal-verification-evidence.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('formal claim binding rejects a buildable theorem that assumes its conclusion', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'migration', 'fixtures', 'legacy-lean-adversarial-v1.json'), 'utf8'));
  const blocked = evaluateFormalClaimBindings(fixture);
  assert.equal(blocked.status, 'formal_claim_binding_blocked');
  assert.ok(blocked.blockers.some((item) => item.endsWith('target_conclusion_assumed_as_premise')));
  const formalClaimContract = buildFormalClaimContract({
    claimId: 'claim-1', claimText: 'The verified theorem holds.', sourceLocator: 'paper.tex#claim-1', theoremName: 'verifiedTheorem',
    theoremTypeHash: 'sha256:type', sourceStatementHash: 'sha256:statement', proofObligations: ['verifiedTheorem'],
    manuscriptSourceIdentity: { path: 'paper.tex', byteStart: 0, byteEnd: 4, contentHash: 'sha256:claim', fileHash: 'sha256:paper' },
    semanticReview: { status: 'formal_semantic_review_verified', reviewerId: 'reviewer', authorId: 'author', semanticEquivalenceVerified: true, reviewReceiptHash: hashRecord('FormalSemanticReviewReceipt', { claimId: 'claim-1' }), reviewEnvelopeHash: 'sha256:envelope', reviewNodeId: 'review-node', reviewAttemptId: 'review-attempt', reviewAgentReceiptHash: 'sha256:review-agent', authorNodeId: 'author-node', authorAgentReceiptHash: 'sha256:author-agent', reviewedManuscriptHash: 'sha256:paper', reviewedWorkerPlanHash: 'sha256:plan' },
  });
  const verified = evaluateFormalClaimBindings({
    claims: [{ claimId: 'claim-1', theoremName: 'verifiedTheorem', expectedTypeHash: 'sha256:type', sourceStatementHash: 'sha256:statement', proofObligations: ['verifiedTheorem'], manuscriptClaimHash: formalClaimContract.manuscriptClaimHash, formalClaimContract, unconditional: true }],
    declarations: [{ name: 'verifiedTheorem', typeHash: 'sha256:type', sourceStatementHash: 'sha256:statement', buildVerified: true, conditional: false, verifiedObligations: ['verifiedTheorem'], axioms: [] }],
  });
  assert.equal(verified.status, 'formal_claim_binding_verified');
});

test('formal claim binding requires explicit obligation coverage and rejects vacuous True', () => {
  const report = evaluateFormalClaimBindings({
    claims: [{ claimId: 'claim-coverage', theoremName: 'target', expectedTypeHash: 'sha256:type', proofObligations: ['target', 'supportingLemma'] }],
    declarations: [{ name: 'target', typeHash: 'sha256:type', buildVerified: true, conclusion: 'True', vacuous: true, verifiedObligations: ['target'], axioms: [] }],
  });
  assert.ok(report.blockers.some((item) => item.endsWith('target_theorem_vacuous_true')));
  assert.ok(report.blockers.some((item) => item.endsWith('target_theorem_obligation_coverage_incomplete')));
});

test('natural-language proof obligations use stable ids mapped to audited Lean declarations', () => {
  const proofObligations = [
    'Establish reflexivity for an arbitrary natural number.',
    'Close the equality goal without additional axioms.',
  ];
  const proofObligationContracts = createProofObligationContracts({
    claimKey: 'natural-reflexivity',
    proofObligations,
  });
  const proofObligationMappings = proofObligationContracts.map((contract) => ({
    ...contract,
    leanDeclarations: ['reflexiveIdentity'],
  }));
  const semanticReview = {
    status: 'formal_semantic_review_verified', reviewerId: 'reviewer', authorId: 'author',
    semanticEquivalenceVerified: true,
    reviewReceiptHash: hashRecord('FormalSemanticReviewReceipt', { claimId: 'natural-reflexivity' }),
    reviewEnvelopeHash: 'sha256:envelope', reviewNodeId: 'review-node', reviewAttemptId: 'review-attempt',
    reviewAgentReceiptHash: 'sha256:review-agent', authorNodeId: 'author-node',
    authorAgentReceiptHash: 'sha256:author-agent', reviewedManuscriptHash: 'sha256:paper',
    reviewedWorkerPlanHash: 'sha256:plan',
  };
  const formalClaimContract = buildFormalClaimContract({
    claimId: 'natural-reflexivity', claimText: 'Every natural number equals itself.',
    sourceLocator: 'paper.tex#claim', theoremName: 'reflexiveIdentity',
    theoremTypeHash: 'sha256:type', sourceStatementHash: 'sha256:statement',
    proofObligations, proofObligationContracts, proofObligationMappings,
    manuscriptSourceIdentity: {
      path: 'paper.tex', byteStart: 0, byteEnd: 4,
      contentHash: 'sha256:claim', fileHash: 'sha256:paper',
    },
    semanticReview,
  });
  const report = evaluateFormalClaimBindings({
    claims: [{
      claimId: 'natural-reflexivity', theoremName: 'reflexiveIdentity',
      expectedTypeHash: 'sha256:type', sourceStatementHash: 'sha256:statement',
      proofObligations, proofObligationContracts, proofObligationMappings,
      manuscriptClaimHash: formalClaimContract.manuscriptClaimHash, formalClaimContract,
    }],
    declarations: [{
      name: 'reflexiveIdentity', typeHash: 'sha256:type', sourceStatementHash: 'sha256:statement',
      buildVerified: true, axioms: [],
      verifiedObligations: proofObligationContracts.map((contract) => contract.obligationId),
    }],
  });
  assert.equal(report.status, 'formal_claim_binding_verified', JSON.stringify(report.blockers));
  assert.deepEqual(report.bindings[0].verifiedObligations,
    proofObligationContracts.map((contract) => contract.obligationId).sort());

  const tampered = evaluateFormalClaimBindings({
    claims: [{
      claimId: 'natural-reflexivity', theoremName: 'reflexiveIdentity',
      expectedTypeHash: 'sha256:type', sourceStatementHash: 'sha256:statement',
      proofObligations, proofObligationContracts,
      proofObligationMappings: proofObligationMappings.map((mapping, index) => (
        index === 0 ? { ...mapping, displayText: 'Different obligation.' } : mapping
      )),
      formalClaimContract,
    }],
    declarations: [],
  });
  assert.ok(tampered.blockers.some((blocker) => blocker.includes('formal_proof_obligation_mappings_invalid')));
});

test('theorem specifications make assumptions, quantifiers, boundaries, and proof obligations explicit and hash-bound', () => {
  const specification = createTheoremSpecification({
    paperId: 'paper-1',
    campaignId: 'campaign-1',
    sourceManuscriptPath: 'main.tex',
    sourceManuscriptHash: `sha256:${'a'.repeat(64)}`,
    formalClaimUniverseHash: `sha256:${'b'.repeat(64)}`,
    claims: [{
      claimKey: 'main-convergence',
      title: 'Convergence under bounded noise',
      statement: 'For every admissible sequence, the estimator converges in probability.',
      assumptions: ['The observations are independent.', 'The variance is uniformly bounded.'],
      quantifiers: ['For every positive tolerance epsilon.', 'For every admissible observation sequence.'],
      negativeBoundaries: ['No almost-sure convergence is claimed.', 'Adversarial dependence is outside scope.'],
      proofObligations: ['Bound the estimator variance.', 'Apply the probability convergence criterion.'],
      evidenceObligations: ['Empirically test finite-sample sensitivity.'],
      manuscriptIntent: 'new',
      manuscriptSource: {
        path: 'main.tex', byteStart: 10, byteEnd: 20,
        contentHash: `sha256:${'c'.repeat(64)}`,
        formalClaimUniverseEntryHash: `sha256:${'d'.repeat(64)}`,
      },
    }],
  });
  assert.equal(verifyTheoremSpecification(specification, {
    paperId: 'paper-1', campaignId: 'campaign-1', sourceManuscriptHash: `sha256:${'a'.repeat(64)}`,
    formalClaimUniverseHash: `sha256:${'b'.repeat(64)}`,
  }).valid, true);
  assert.match(specification.claims[0].claimId, /^theorem:[a-f0-9]{64}$/);
  const tampered = structuredClone(specification);
  tampered.claims[0].statement = 'A stronger unsupported theorem holds.';
  assert.equal(verifyTheoremSpecification(tampered).valid, false);
  assert.throws(() => createTheoremSpecification({
    paperId: 'paper-1', campaignId: 'campaign-1', sourceManuscriptPath: 'main.tex',
    sourceManuscriptHash: `sha256:${'a'.repeat(64)}`,
    formalClaimUniverseHash: `sha256:${'b'.repeat(64)}`,
    claims: [{
      claimKey: 'unsafe', title: 'Unsafe', statement: 'Claim', assumptions: [], quantifiers: [],
      negativeBoundaries: [], proofObligations: [],
      manuscriptSource: {
        path: 'main.tex', byteStart: 10, byteEnd: 20,
        contentHash: `sha256:${'c'.repeat(64)}`,
        formalClaimUniverseEntryHash: `sha256:${'d'.repeat(64)}`,
      },
    }],
  }), /claim_negative_boundaries_invalid/);
});

test('theorem specification drafts are finalized by the system and bound to the manuscript bytes', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-theorem-specification-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const manuscript = '\\begin{theorem}A bounded claim.\\end{theorem}\n\\begin{proof}Immediate.\\end{proof}\n';
  fs.writeFileSync(path.join(workspace, 'main.tex'), manuscript);
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), JSON.stringify({
    version: 1,
    kind: 'TheoremSpecificationDraft',
    claims: [{
      claimKey: 'bounded-claim', title: 'Bounded claim', statement: 'A bounded claim.',
      assumptions: [], quantifiers: [], negativeBoundaries: ['No stronger claim is made.'],
      proofObligations: ['Prove the bounded claim.'], evidenceObligations: [], manuscriptIntent: 'existing',
    }],
  }));
  const receipt = finalizeTheoremSpecification({
    workspace, manuscriptPath: 'main.tex', paperId: 'paper', campaignId: 'campaign',
  });
  assert.equal(receipt.status, 'theorem_specification_finalized');
  const universe = readFormalClaimUniverse({ sourceRoot: workspace, manuscriptPath: 'main.tex' });
  assert.equal(receipt.sourceManuscriptHash, universe.manuscriptHash);
  assert.equal(fs.existsSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json')), false);
  const specification = JSON.parse(fs.readFileSync(path.join(workspace, 'THEOREM_SPEC.json'), 'utf8'));
  assert.equal(verifyTheoremSpecification(specification, {
    paperId: 'paper', campaignId: 'campaign', sourceManuscriptHash: universe.manuscriptHash,
    formalClaimUniverseHash: universe.formalClaimUniverseHash,
  }).valid, true);
});

test('approved proposal claims are externally rebound and an unrelated theorem is rejected by independent semantic lineage review', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-proposal-theorem-lineage-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const proposalEnvelopeHash = hashRecord('ProposalLineageEnvelopeFixture', {});
  const productionPlanEnvelopeHash = hashRecord('ProposalLineagePlanFixture', {});
  const reviewGateHash = hashRecord('ProposalLineageGateFixture', {});
  const seedPayload = {
    version: 1,
    kind: 'PaperProposalSeedContractBundle',
    paperId: 'paper-lineage',
    taskKey: 'paper_factory:paper-lineage',
    status: 'proposal_seed_contracts_ready',
    proposalEnvelopeHash,
    productionPlanEnvelopeHash,
    reviewGateHash,
    claims: [{
      id: 'proposal:convergence', kind: 'proposal_claim_seed',
      text: 'Every admissible estimator converges under bounded noise.', status: 'proposal_seed',
      scientificClaimKey: 'bounded-noise-convergence',
      assumptions: ['Noise is bounded.'],
      quantifiers: ['For every admissible estimator.'],
      negativeBoundaries: ['No claim under unbounded noise is made.'],
      proofObligations: ['Prove convergence.'],
    }],
    proof_obligations: [{ id: 'proof:convergence', text: 'Prove convergence.' }],
    evidence: [], reproducibility: [], blockers: [], warnings: [],
  };
  const proposalSeedContractBundleHash = hashPaperRecord('PaperProposalSeedContractBundle', seedPayload);
  const seedBundle = { ...seedPayload, paperProposalSeedContractBundleHash: proposalSeedContractBundleHash };
  fs.writeFileSync(path.join(workspace, 'SEED.json'), `${JSON.stringify(seedBundle, null, 2)}\n`);
  const bindingPayload = {
    version: 1, kind: 'ApprovedProposalSeedBinding', status: 'approved_proposal_seed_bound',
    contractPath: 'SEED.json', proposalEnvelopeHash, productionPlanEnvelopeHash, reviewGateHash,
    proposalSeedContractBundleHash,
  };
  const approvedProposalSeed = {
    ...bindingPayload,
    approvedProposalSeedBindingHash: hashRecord('ApprovedProposalSeedBinding', bindingPayload),
  };
  const unrelated = 'For every natural number n, n equals n.';
  fs.writeFileSync(path.join(workspace, 'main.tex'), [
    `\\begin{theorem}${unrelated}\\end{theorem}`,
    '\\begin{proof}By reflexivity.\\end{proof}', '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), JSON.stringify({
    version: 1, kind: 'TheoremSpecificationDraft',
    claims: [{
      claimKey: 'bounded-noise-convergence', title: 'Reflexivity', statement: unrelated,
      assumptions: ['Noise is bounded.'], quantifiers: ['For every admissible estimator.'],
      negativeBoundaries: ['No claim under unbounded noise is made.'],
      proofObligations: ['Prove convergence.'], evidenceObligations: [], manuscriptIntent: 'existing',
      proposalClaimId: 'proposal:convergence',
    }],
  }));
  finalizeTheoremSpecification({
    workspace, manuscriptPath: 'main.tex', paperId: 'paper-lineage', campaignId: 'campaign-lineage',
    approvedProposalSeed,
  });
  const specification = readFinalizedTheoremSpecification({
    workspace, manuscriptPath: 'main.tex', paperId: 'paper-lineage', campaignId: 'campaign-lineage',
    approvedProposalSeed,
  });
  const claim = specification.claims[0];
  assert.equal(claim.proposalClaimSource.proposalClaimText, seedBundle.claims[0].text);
  const leanSource = 'theorem unrelatedReflexivity (n : Nat) : n = n := by rfl\n';
  const declaration = leanSourceDeclarationRecords(leanSource).find((item) => item.name === 'unrelatedReflexivity');
  fs.writeFileSync(path.join(workspace, 'Main.lean'), leanSource);
  fs.writeFileSync(path.join(workspace, 'RESEARCH_WORKER_PLAN.json'), JSON.stringify({
    version: 1, kind: 'NativeResearchWorkerPlan', paperId: 'paper-lineage',
    taskKey: 'paper_factory:paper-lineage',
    workers: [{
      id: 'unrelated-proof', type: 'formal_verifier_lake', evidenceClass: 'research_evidence',
      syntheticInput: false, outcomesPreprogrammed: false, claimIds: [claim.claimId],
      inputs: [{ role: 'formal_source', path: 'Main.lean', sha256: hashBytes(Buffer.from(leanSource)) }],
      parameters: { projectRoot: '.', executable: 'lake', claimBindings: [{
        claimId: claim.claimId,
        theoremSpecificationHash: specification.theoremSpecificationHash,
        theoremSpecificationClaimHash: claim.theoremSpecificationClaimHash,
        theoremName: declaration.name, sourceFile: 'Main.lean',
        expectedTypeHash: declaration.typeHash, sourceStatementHash: declaration.statementHash,
        proofObligations: claim.proofObligations,
        manuscriptSource: {
          path: claim.manuscriptSource.path, byteStart: claim.manuscriptSource.byteStart,
          byteEnd: claim.manuscriptSource.byteEnd, contentHash: claim.manuscriptSource.contentHash,
        },
      }] },
    }],
  }));
  const agentReceipt = (agentId, structuredOutput = null) => {
    const payload = {
      status: 'agent_execution_completed', providerMode: 'openclaw:detached-child-session',
      executorId: 'proposal-lineage-fixture', agentId,
      agentCapabilityProfileHash: hashRecord('ProposalLineageAgentCapability', { agentId }),
      openClawAgentConfigurationHash: hashRecord('ProposalLineageAgentConfiguration', { agentId }),
      openClawGatewayConfigurationHash: hashRecord('ProposalLineageGatewayConfiguration', {}),
      resolvedModel: 'fixture', structuredOutput,
      finalOutput: structuredOutput ? JSON.stringify(structuredOutput) : '', changedPaths: [],
      externalActionPerformed: false,
    };
    return { ...payload, agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload) };
  };
  const sourceLocator = `${claim.manuscriptSource.path}#bytes=${claim.manuscriptSource.byteStart}-${claim.manuscriptSource.byteEnd}`;
  const authorReceipt = agentReceipt('unrelated-formal-author');
  const rejectedReviewReceipt = agentReceipt('independent-lineage-reviewer', {
    version: 2, kind: 'FormalClaimSemanticReview',
    theoremSpecificationHash: specification.theoremSpecificationHash,
    reviews: [{
      claimId: claim.claimId, theoremName: declaration.name,
      manuscriptClaimHash: manuscriptClaimHash({ claimId: claim.claimId, text: claim.statement, sourceLocator }),
      theoremTypeHash: declaration.typeHash, sourceStatementHash: declaration.statementHash,
      status: 'formal_semantic_review_verified', semanticEquivalenceVerified: true, verdict: 'equivalent',
      proposalClaimId: claim.proposalClaimSource.proposalClaimId,
      proposalClaimRecordHash: claim.proposalClaimSource.proposalClaimRecordHash,
      proposalClaimTextHash: claim.proposalClaimSource.proposalClaimTextHash,
      proposalToTheoremSemanticVerified: false, proposalToTheoremVerdict: 'unrelated',
      approvedNarrowingRationale: null,
    }],
  });
  const rejectedEnvelope = buildCampaignFormalReviewEnvelope({
    campaign: {
      campaignId: 'campaign-lineage', paperId: 'paper-lineage',
      spec: { approvedProposalSeed },
    },
    node: { nodeId: 'formal-review', attemptId: 'review-attempt' },
    authorNode: { nodeId: 'formal-author', result: authorReceipt },
    receipt: rejectedReviewReceipt, workspace, manuscript: 'main.tex',
  });
  assert.equal(rejectedEnvelope.status, 'formal_semantic_review_envelope_blocked');
  assert.ok(rejectedEnvelope.blockers.some((blocker) => blocker.includes('proposal_claim_to_theorem_semantic_review_invalid')));
  const approvedReviewDocument = structuredClone(rejectedReviewReceipt.structuredOutput);
  approvedReviewDocument.reviews[0].proposalToTheoremSemanticVerified = true;
  approvedReviewDocument.reviews[0].proposalToTheoremVerdict = 'equivalent';
  const approvedReviewReceipt = agentReceipt('independent-lineage-reviewer-approved', approvedReviewDocument);
  const approvedEnvelope = buildCampaignFormalReviewEnvelope({
    campaign: {
      campaignId: 'campaign-lineage', paperId: 'paper-lineage',
      spec: { approvedProposalSeed },
    },
    node: { nodeId: 'formal-review-approved', attemptId: 'review-attempt-approved' },
    authorNode: { nodeId: 'formal-author', result: authorReceipt },
    receipt: approvedReviewReceipt, workspace, manuscript: 'main.tex',
  });
  assert.equal(approvedEnvelope.status, 'formal_semantic_review_envelope_verified');
  const resealedEnvelopePayload = structuredClone(approvedEnvelope);
  delete resealedEnvelopePayload.formalSemanticReviewEnvelopeHash;
  const resealedProposalBindingPayload = structuredClone(resealedEnvelopePayload.proposalClaimToTheoremBinding);
  delete resealedProposalBindingPayload.proposalClaimToTheoremBindingHash;
  resealedProposalBindingPayload.entries[0].proposalToTheoremVerdict = 'approved_narrowing';
  resealedProposalBindingPayload.entries[0].approvedNarrowingRationale = 'Attacker-resealed narrowing.';
  const resealedProposalBinding = {
    ...resealedProposalBindingPayload,
    proposalClaimToTheoremBindingHash:
      hashRecord('ProposalClaimToTheoremBinding', resealedProposalBindingPayload),
  };
  resealedEnvelopePayload.reviews[0].proposalToTheoremVerdict = 'approved_narrowing';
  resealedEnvelopePayload.reviews[0].approvedNarrowingRationale = 'Attacker-resealed narrowing.';
  resealedEnvelopePayload.proposalClaimToTheoremBinding = resealedProposalBinding;
  resealedEnvelopePayload.proposalClaimToTheoremBindingHash =
    resealedProposalBinding.proposalClaimToTheoremBindingHash;
  const fullyResealedEnvelope = {
    ...resealedEnvelopePayload,
    formalSemanticReviewEnvelopeHash:
      hashPaperRecord('FormalClaimSemanticReviewEnvelope', resealedEnvelopePayload),
  };
  const unchangedReceiptVerification = verifyFormalReviewAgentReceiptBinding({
    receipt: approvedReviewReceipt,
    reviewEnvelope: fullyResealedEnvelope,
    theoremSpecification: specification,
  });
  assert.equal(unchangedReceiptVerification.valid, false);
  assert.ok(unchangedReceiptVerification.blockers.includes('formal_review_agent_envelope_reviews_mismatch'));
  assert.throws(() => createProposalClaimToTheoremBinding({
    paperId: 'paper-lineage', campaignId: 'campaign-lineage', theoremSpecification: specification,
    reviewAuthority: {
      reviewAgentReceiptHash: `sha256:${'a'.repeat(64)}`,
      reviewerPrincipalId: `sha256:${'b'.repeat(64)}`,
    },
    reviews: [{
      claimId: claim.claimId,
      proposalClaimId: claim.proposalClaimSource.proposalClaimId,
      proposalClaimRecordHash: claim.proposalClaimSource.proposalClaimRecordHash,
      proposalClaimTextHash: claim.proposalClaimSource.proposalClaimTextHash,
      proposalToTheoremSemanticVerified: false,
      proposalToTheoremVerdict: 'unrelated',
      approvedNarrowingRationale: null,
    }],
  }), /proposal_claim_to_theorem_semantic_review_invalid/);

  const structurallyApprovedReview = [{
    claimId: claim.claimId,
    proposalClaimId: claim.proposalClaimSource.proposalClaimId,
    proposalClaimRecordHash: claim.proposalClaimSource.proposalClaimRecordHash,
    proposalClaimTextHash: claim.proposalClaimSource.proposalClaimTextHash,
    proposalToTheoremSemanticVerified: true,
    proposalToTheoremVerdict: 'equivalent',
    approvedNarrowingRationale: null,
  }];
  assert.throws(() => createProposalClaimToTheoremBinding({
    paperId: 'paper-lineage', campaignId: 'campaign-lineage', theoremSpecification: specification,
    reviewAuthority: {
      reviewAgentReceiptHash: `sha256:${'a'.repeat(64)}`,
      reviewerPrincipalId: `sha256:${'b'.repeat(64)}`,
    },
    reviews: [{
      ...structurallyApprovedReview[0],
      proposalToTheoremVerdict: 'approved_narrowing',
      approvedNarrowingRationale: 'A reviewer cannot unilaterally change operator-approved scope.',
    }],
  }), /proposal_claim_to_theorem_semantic_review_invalid/);
  const validBinding = createProposalClaimToTheoremBinding({
    paperId: 'paper-lineage', campaignId: 'campaign-lineage', theoremSpecification: specification,
    reviews: structurallyApprovedReview,
    reviewAuthority: {
      reviewAgentReceiptHash: `sha256:${'a'.repeat(64)}`,
      reviewerPrincipalId: `sha256:${'b'.repeat(64)}`,
    },
  });
  const resealedPayload = structuredClone(validBinding);
  delete resealedPayload.proposalClaimToTheoremBindingHash;
  resealedPayload.entries[0].theoremStatement = 'A fully resealed unrelated statement.';
  const resealedBinding = {
    ...resealedPayload,
    proposalClaimToTheoremBindingHash: hashRecord('ProposalClaimToTheoremBinding', resealedPayload),
  };
  const resealedVerification = verifyProposalClaimToTheoremBinding(resealedBinding, {
    paperId: 'paper-lineage', campaignId: 'campaign-lineage', theoremSpecification: specification,
    reviews: structurallyApprovedReview,
  });
  assert.equal(resealedVerification.valid, false);
  assert.ok(resealedVerification.blockers.some((blocker) => blocker.includes('specification_entry_mismatch')));

  const authority = verifyApprovedProposalSeedLineageAuthority({
    approvedProposalSeed, proposalSeedContractBundle: seedBundle, paperId: 'paper-lineage',
  });
  assert.equal(authority.valid, true);
  const attackerClaim = structuredClone(claim);
  attackerClaim.proposalClaimSource.proposalClaimText = unrelated;
  attackerClaim.proposalClaimSource.proposalClaimTextHash = hashBytes(Buffer.from(unrelated));
  const attackerSpecification = createTheoremSpecification({
    paperId: specification.paperId,
    campaignId: specification.campaignId,
    sourceManuscriptPath: specification.sourceManuscriptPath,
    sourceManuscriptHash: specification.sourceManuscriptHash,
    formalClaimUniverseHash: specification.formalClaimUniverseHash,
    approvedProposalSeedBindingHash: specification.approvedProposalSeedBindingHash,
    proposalSeedContractBundleHash: specification.proposalSeedContractBundleHash,
    claimAuthorityType: specification.claimAuthorityType,
    claimAuthorityBindingHash: specification.claimAuthorityBindingHash,
    claimAuthorityBundleHash: specification.claimAuthorityBundleHash,
    claims: [attackerClaim],
  });
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC.json'), `${JSON.stringify(attackerSpecification, null, 2)}\n`);
  assert.throws(() => readFinalizedTheoremSpecification({
    workspace, manuscriptPath: 'main.tex', paperId: 'paper-lineage', campaignId: 'campaign-lineage',
    approvedProposalSeed,
  }), /proposal_claim/);
});
