import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFormalProofBackendSelection,
  buildFormalProofStrategyPreparation,
  FORMAL_PROOF_SEARCH_BACKENDS,
  FORMAL_PROOF_SEARCH_STRATEGIES,
  FORMAL_PROOF_STRATEGY_REGISTRY_HASH,
  verifyFormalProofStrategyPreparation,
} from '../../paper-domain/research/formal-proof-strategy-registry.mjs';
import {
  buildTypedTheoremDslFromLeanType,
  searchTypedTheoremDslCounterexample,
} from '../../paper-domain/research/typed-theorem-dsl.mjs';

test('formal strategy registry exposes bounded capabilities and honest backend availability', () => {
  assert.match(FORMAL_PROOF_STRATEGY_REGISTRY_HASH, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(FORMAL_PROOF_SEARCH_STRATEGIES.map((entry) => entry.strategy), [
    'direct_elaboration',
    'mathlib_retrieval',
    'bounded_refutation_or_synthesis',
  ]);
  assert.deepEqual(FORMAL_PROOF_SEARCH_BACKENDS.map((entry) => [
    entry.backend,
    entry.availability,
  ]), [
    ['lean', 'active'],
    ['coq', 'unavailable'],
    ['isabelle', 'unavailable'],
  ]);
  const lean = buildFormalProofBackendSelection({ backend: 'lean' });
  assert.equal(lean.status, 'formal_proof_backend_selected');
  assert.equal(lean.executablePresenceGrantsQualification, false);
  for (const backend of ['coq', 'isabelle']) {
    const unavailable = buildFormalProofBackendSelection({ backend });
    assert.equal(unavailable.status, 'formal_proof_backend_selection_blocked');
    assert.deepEqual(unavailable.blockers, [`formal_proof_backend_unavailable:${backend}`]);
  }
});

test('strategy preparation decomposes goals and emits replay-bound proof-term candidates', () => {
  const dsl = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ n : Nat, n = n → n = n',
    allowedImports: ['Init'],
  });
  const preparation = buildFormalProofStrategyPreparation({
    strategy: 'direct_elaboration',
    dsl,
  });
  assert.equal(preparation.status, 'formal_proof_strategy_preparation_ready');
  assert.deepEqual(preparation.goalDecomposition.introductionNames, [
    'n',
    'heptaAssumption1',
  ]);
  assert.equal(preparation.goalDecomposition.semanticEquivalenceEstablished, false);
  assert.deepEqual(
    preparation.proofTermSynthesis.candidates.map((candidate) => candidate.proofTermSource),
    ['by\n  rfl'],
  );
  assert.equal(preparation.proofTermSynthesis.kernelElaborationRequired, true);
  assert.equal(preparation.semanticBoundary.scientificTruthEstablished, false);
  assert.equal(verifyFormalProofStrategyPreparation(preparation, {
    strategy: 'direct_elaboration',
    dsl,
  }), true);

  const tampered = structuredClone(preparation);
  tampered.semanticBoundary.scientificTruthEstablished = true;
  assert.equal(verifyFormalProofStrategyPreparation(tampered, {
    strategy: 'direct_elaboration',
    dsl,
  }), false);
});

test('counterexample-guided repair proposes review without mutating the claim', () => {
  const dsl = buildTypedTheoremDslFromLeanType({
    leanTypeSource: '∀ n : Fin 4, n = 3',
    allowedImports: ['Init'],
  });
  const counterexampleSearchReceipts = Object.freeze([
    searchTypedTheoremDslCounterexample(dsl),
  ]);
  const preparation = buildFormalProofStrategyPreparation({
    strategy: 'bounded_refutation_or_synthesis',
    dsl,
    counterexampleSearchReceipts,
  });
  assert.equal(
    preparation.counterexampleGuidedRepair.status,
    'formal_proof_counterexample_guided_repair_proposed',
  );
  assert.equal(preparation.counterexampleGuidedRepair.claimMutationAllowed, false);
  assert.equal(preparation.counterexampleGuidedRepair.automaticRepairAllowed, false);
  assert.equal(
    preparation.counterexampleGuidedRepair.proposedDisposition,
    'reject_or_reformalize_via_independent_semantic_authority',
  );
  assert.equal(preparation.lemmaRetrieval.requested, false);
  assert.equal(verifyFormalProofStrategyPreparation(preparation, {
    strategy: 'bounded_refutation_or_synthesis',
    dsl,
    counterexampleSearchReceipts,
  }), true);
});
