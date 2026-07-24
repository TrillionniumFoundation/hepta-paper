import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { finalizeTheoremSpecification } from '../../paper-adapters/automation/theorem-specification-finalizer.mjs';
import {
  createFormalProofSearchAttemptReceipt,
  createFormalProofSearchFailureCertificate,
  createFormalProofSearchPlan,
  createTypedTheoremObligationBundle,
  verifyFormalProofSearchAttempts,
  verifyFormalProofSearchPlan,
  verifyTypedTheoremObligationBundle,
} from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function theoremSpecificationFixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-typed-theorem-search-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const statement = 'For every natural number n, n equals n.';
  fs.writeFileSync(path.join(workspace, 'main.tex'), [
    `\\begin{theorem}${statement}\\end{theorem}`,
    '\\begin{proof}By reflexivity.\\end{proof}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'THEOREM_SPEC_DRAFT.json'), `${JSON.stringify({
    version: 1,
    kind: 'TheoremSpecificationDraft',
    claims: [{
      claimKey: 'typed-reflexivity',
      title: 'Typed reflexivity',
      statement,
      assumptions: [],
      quantifiers: ['For every natural number n.'],
      negativeBoundaries: ['No equality of distinct values is claimed.'],
      proofObligations: ['Prove reflexivity for the bound value.'],
      evidenceObligations: [],
      manuscriptIntent: 'existing',
    }],
  }, null, 2)}\n`);
  finalizeTheoremSpecification({
    workspace,
    manuscriptPath: 'main.tex',
    paperId: 'typed-proof-paper',
    campaignId: 'typed-proof-campaign',
  });
  return JSON.parse(fs.readFileSync(path.join(workspace, 'THEOREM_SPEC.json'), 'utf8'));
}

test('typed theorem obligation bundle binds exact specification semantics and explicit limits', (t) => {
  const theoremSpecification = theoremSpecificationFixture(t);
  const bundle = createTypedTheoremObligationBundle(theoremSpecification);
  assert.equal(bundle.status, 'typed_theorem_obligation_bundle_ready');
  assert.equal(bundle.obligations.length, 1);
  assert.equal(bundle.obligations[0].goalAuthority, 'semantic_review_required');
  assert.equal(bundle.obligations[0].kernelVerificationRequired, true);
  assert.equal(bundle.obligations[0].naturalLanguageEquivalenceReviewRequired, true);
  assert.deepEqual(bundle.limitations, {
    openWorldTheoremDiscoveryGuaranteed: false,
    scientificTruthGuaranteed: false,
    naturalLanguageToLeanEquivalenceKernelProven: false,
    counterexampleAbsenceEstablishesTruth: false,
  });
  assert.equal(verifyTypedTheoremObligationBundle(bundle, { theoremSpecification }).valid, true);

  const tampered = structuredClone(bundle);
  tampered.limitations.scientificTruthGuaranteed = true;
  const verification = verifyTypedTheoremObligationBundle(tampered, { theoremSpecification });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('typed_theorem_obligation_bundle_not_canonical'));
});

test('proof search plan is a fixed proof-state, Mathlib, and bounded-refutation sequence', (t) => {
  const theoremSpecification = theoremSpecificationFixture(t);
  const bundle = createTypedTheoremObligationBundle(theoremSpecification);
  const plan = createFormalProofSearchPlan(bundle);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.strategy), [
    'direct_elaboration',
    'mathlib_retrieval',
    'bounded_refutation_or_synthesis',
  ]);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.requiredOperations), [
    ['lean_elaboration', 'proof_state_inspection'],
    ['lean_elaboration', 'proof_state_inspection', 'pinned_mathlib_symbol_search'],
    [
      'lean_elaboration', 'proof_state_inspection', 'pinned_mathlib_symbol_search',
      'bounded_counterexample_search',
    ],
  ]);
  assert.equal(plan.candidates.every((candidate) => !candidate.claimMutationAllowed), true);
  assert.equal(plan.candidates.every((candidate) => !candidate.unpinnedNetworkRetrievalAllowed), true);
  assert.equal(verifyFormalProofSearchPlan(plan, { bundle }).valid, true);

  const tampered = structuredClone(plan);
  tampered.candidates[1].unpinnedNetworkRetrievalAllowed = true;
  assert.equal(verifyFormalProofSearchPlan(tampered, { bundle }).valid, false);
});

test('exhausted bounded proof search emits a canonical failure certificate without truth claims', (t) => {
  const theoremSpecification = theoremSpecificationFixture(t);
  const bundle = createTypedTheoremObligationBundle(theoremSpecification);
  const plan = createFormalProofSearchPlan(bundle);
  const fixtureHash = (kind, ordinal) => hashRecord(kind, { ordinal });
  const attempts = plan.candidates.map((candidate, ordinal) => (
    createFormalProofSearchAttemptReceipt({
      plan,
      candidate,
      authorAgentReceiptHash: fixtureHash('ProofSearchAuthorFixture', ordinal),
      reviewAgentReceiptHash: fixtureHash('ProofSearchReviewFixture', ordinal),
      formalReviewEnvelopeHash: fixtureHash('ProofSearchEnvelopeFixture', ordinal),
      campaignFormalVerificationReceiptHash:
        fixtureHash('ProofSearchVerificationFixture', ordinal),
      blockers: [`kernel_candidate_rejected:${ordinal}`],
    })
  ));
  assert.equal(verifyFormalProofSearchAttempts(attempts, {
    plan,
    expectedCount: 3,
  }).valid, true);
  const certificate = createFormalProofSearchFailureCertificate({ plan, attempts });
  assert.equal(certificate.status, 'formal_proof_search_exhausted');
  assert.equal(certificate.kernelProofStatus, 'not_established');
  assert.equal(certificate.counterexampleStatus, 'not_established');
  assert.equal(certificate.limitations.counterexampleAbsenceEstablishesTruth, false);
  assert.match(certificate.formalProofSearchFailureCertificateHash, /^sha256:/);

  const reordered = [attempts[1], attempts[0], attempts[2]];
  assert.equal(verifyFormalProofSearchAttempts(reordered, {
    plan,
    expectedCount: 3,
  }).valid, false);
  assert.throws(
    () => createFormalProofSearchFailureCertificate({ plan, attempts: reordered }),
    /formal_proof_search_failure_certificate_attempts_invalid/,
  );
});
