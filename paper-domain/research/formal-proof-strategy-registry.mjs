import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO = Object.freeze({
  direct_elaboration: Object.freeze(['rfl']),
  mathlib_retrieval: Object.freeze(['simp', 'simpa', 'ext i <;> simp', 'aesop']),
  bounded_refutation_or_synthesis: Object.freeze([
    'omega', 'ring_nf', 'linarith', 'nlinarith', 'norm_num', 'positivity', 'aesop', 'simp',
  ]),
});

export const FORMAL_PROOF_SEARCH_BACKENDS = Object.freeze([
  Object.freeze({
    backend: 'lean',
    verifierRegistryKind: 'lean',
    executionMode: 'builtin_pinned_lake',
    availability: 'active',
    productionQualification:
      'conditional_on_current_dynamic_formal_authority_kernel_audit_and_fresh_replay',
  }),
  Object.freeze({
    backend: 'coq',
    verifierRegistryKind: 'coq',
    executionMode: 'out_of_process_adapter_required',
    availability: 'unavailable',
    productionQualification: 'separately_qualified_adapter_required',
  }),
  Object.freeze({
    backend: 'isabelle',
    verifierRegistryKind: 'isabelle',
    executionMode: 'out_of_process_adapter_required',
    availability: 'unavailable',
    productionQualification: 'separately_qualified_adapter_required',
  }),
]);

export const FORMAL_PROOF_SEARCH_STRATEGIES = Object.freeze([
  Object.freeze({
    ordinal: 0,
    strategy: 'direct_elaboration',
    requiredOperations: Object.freeze([
      'syntactic_goal_decomposition',
      'bounded_proof_term_synthesis',
      'lean_elaboration',
      'proof_state_inspection',
    ]),
    capabilities: Object.freeze([
      'goal_decomposition',
      'proof_term_synthesis',
    ]),
    counterexampleDisposition: 'not_requested',
  }),
  Object.freeze({
    ordinal: 1,
    strategy: 'mathlib_retrieval',
    requiredOperations: Object.freeze([
      'syntactic_goal_decomposition',
      'pinned_mathlib_symbol_search',
      'pinned_lemma_retrieval',
      'bounded_proof_term_synthesis',
      'lean_elaboration',
      'proof_state_inspection',
    ]),
    capabilities: Object.freeze([
      'goal_decomposition',
      'pinned_lemma_index',
      'lemma_retrieval',
      'proof_term_synthesis',
    ]),
    counterexampleDisposition: 'not_requested',
  }),
  Object.freeze({
    ordinal: 2,
    strategy: 'bounded_refutation_or_synthesis',
    requiredOperations: Object.freeze([
      'syntactic_goal_decomposition',
      'pinned_mathlib_symbol_search',
      'pinned_lemma_retrieval',
      'bounded_counterexample_search',
      'counterexample_guided_repair',
      'bounded_proof_term_synthesis',
      'lean_elaboration',
      'proof_state_inspection',
    ]),
    capabilities: Object.freeze([
      'goal_decomposition',
      'pinned_lemma_index',
      'lemma_retrieval',
      'bounded_counterexample_search',
      'counterexample_guided_repair',
      'proof_term_synthesis',
    ]),
    counterexampleDisposition: 'bounded_search_inconclusive',
  }),
]);

export const FORMAL_PROOF_STRATEGY_REGISTRY_HASH = hashRecord(
  'FormalProofStrategyRegistry',
  {
    backends: FORMAL_PROOF_SEARCH_BACKENDS,
    strategies: FORMAL_PROOF_SEARCH_STRATEGIES,
    tacticPortfolio: FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO,
  },
);

export function formalProofSearchStrategyDescriptor(strategy) {
  return FORMAL_PROOF_SEARCH_STRATEGIES.find((entry) => (
    entry.strategy === String(strategy || '')
  )) || null;
}

export function formalProofSearchTactics(strategy) {
  const tactics = FORMAL_PROOF_SEARCH_TACTIC_PORTFOLIO[String(strategy || '')];
  if (!tactics) throw new Error('formal_proof_search_strategy_invalid');
  return tactics;
}

export function buildFormalProofBackendSelection({ backend = 'lean' } = {}) {
  const descriptor = FORMAL_PROOF_SEARCH_BACKENDS.find((entry) => (
    entry.backend === String(backend || '').toLowerCase()
  )) || null;
  const blockers = descriptor?.availability === 'active'
    ? [] : [`formal_proof_backend_unavailable:${descriptor?.backend || backend || '<empty>'}`];
  const payload = {
    version: 1,
    kind: 'FormalProofBackendSelection',
    status: blockers.length
      ? 'formal_proof_backend_selection_blocked'
      : 'formal_proof_backend_selected',
    backend: descriptor?.backend || String(backend || '').toLowerCase() || null,
    descriptor,
    executablePresenceGrantsQualification: false,
    blockers: Object.freeze(blockers),
  };
  return Object.freeze({
    ...payload,
    formalProofBackendSelectionHash:
      hashRecord('FormalProofBackendSelection', payload),
  });
}

function buildGoalDecomposition(dsl) {
  const introductionNames = Object.freeze([
    ...dsl.binders.map((binder) => binder.name),
    ...dsl.assumptions.map((_, index) => `heptaAssumption${index + 1}`),
  ]);
  const rootGoal = Object.freeze({
    relation: dsl.conclusion.relation,
    conclusionHash: hashRecord('FormalProofSyntacticConclusion', dsl.conclusion),
    assumptionHashes: Object.freeze(dsl.assumptions.map((assumption) => (
      hashRecord('FormalProofSyntacticAssumption', assumption)
    ))),
  });
  const payload = {
    version: 1,
    kind: 'FormalProofGoalDecomposition',
    status: 'formal_proof_syntactic_goal_decomposition_ready',
    decompositionKind: 'binder_and_implication_introduction',
    sourceLeanTypeHash: dsl.compiledLeanTypeSourceHash,
    introductionNames,
    goalCount: 1,
    rootGoal,
    semanticEquivalenceEstablished: false,
  };
  return Object.freeze({
    ...payload,
    formalProofGoalDecompositionHash:
      hashRecord('FormalProofGoalDecomposition', payload),
  });
}

function buildLemmaRetrieval({ requiredOperations, mathlibSymbolSearchReceipt }) {
  const requested = requiredOperations.includes('pinned_lemma_retrieval');
  const completed = requested
    && mathlibSymbolSearchReceipt?.status === 'pinned_mathlib_symbol_search_completed';
  const declarations = completed
    ? Object.freeze(mathlibSymbolSearchReceipt.results.map((entry) => entry.name))
    : Object.freeze([]);
  const payload = {
    version: 1,
    kind: 'FormalProofLemmaRetrieval',
    status: !requested
      ? 'formal_proof_lemma_retrieval_not_requested'
      : completed
        ? 'formal_proof_pinned_lemma_retrieval_ready'
        : 'formal_proof_pinned_lemma_retrieval_blocked',
    requested,
    pinnedMathlibSymbolSearchReceiptHash:
      mathlibSymbolSearchReceipt?.pinnedMathlibSymbolSearchReceiptHash || null,
    queryHash: mathlibSymbolSearchReceipt?.queryHash || null,
    indexManifestHash: mathlibSymbolSearchReceipt?.indexManifestHash || null,
    retrievedDeclarationNames: declarations,
    selectedDeclarationName: null,
    automaticDeclarationInjectionAllowed: false,
    networkAccessAllowed: false,
    blockers: Object.freeze(requested && !completed
      ? ['formal_proof_pinned_lemma_index_unavailable'] : []),
  };
  return Object.freeze({
    ...payload,
    formalProofLemmaRetrievalHash:
      hashRecord('FormalProofLemmaRetrieval', payload),
  });
}

function buildProofTermSynthesis({ descriptor, goalDecomposition }) {
  const candidates = Object.freeze(formalProofSearchTactics(descriptor.strategy)
    .map((tactic, ordinal) => Object.freeze({
      ordinal,
      tactic,
      proofTermSource: `by\n  ${tactic}`,
      proofTermSourceHash: hashBytes(Buffer.from(`by\n  ${tactic}`, 'utf8')),
    })));
  const payload = {
    version: 1,
    kind: 'FormalProofTermSynthesisPlan',
    status: 'formal_proof_term_synthesis_plan_ready',
    formalProofGoalDecompositionHash:
      goalDecomposition.formalProofGoalDecompositionHash,
    synthesisMode: 'fixed_reviewed_tactic_templates',
    candidates,
    candidateCount: candidates.length,
    retrievedDeclarationInjectionAllowed: false,
    kernelElaborationRequired: true,
    freshReplayRequired: true,
  };
  return Object.freeze({
    ...payload,
    formalProofTermSynthesisPlanHash:
      hashRecord('FormalProofTermSynthesisPlan', payload),
  });
}

function buildCounterexampleGuidedRepair({ requiredOperations, counterexampleSearchReceipts }) {
  const requested = requiredOperations.includes('counterexample_guided_repair');
  const witnessReceipt = requested
    ? counterexampleSearchReceipts.find((entry) => (
      entry?.status === 'bounded_counterexample_found' && entry?.witness
    )) || null : null;
  const payload = {
    version: 1,
    kind: 'FormalProofCounterexampleGuidedRepair',
    status: !requested
      ? 'formal_proof_counterexample_guided_repair_not_requested'
      : witnessReceipt
        ? 'formal_proof_counterexample_guided_repair_proposed'
        : 'formal_proof_counterexample_guided_repair_not_triggered',
    requested,
    counterexampleResultHash: witnessReceipt?.resultHash || null,
    witnessHash: witnessReceipt
      ? hashRecord('FormalProofCounterexampleWitness', witnessReceipt.witness) : null,
    proposedDisposition: witnessReceipt
      ? 'reject_or_reformalize_via_independent_semantic_authority' : null,
    claimMutationAllowed: false,
    automaticRepairAllowed: false,
    independentSemanticReviewRequired: true,
  };
  return Object.freeze({
    ...payload,
    formalProofCounterexampleGuidedRepairHash:
      hashRecord('FormalProofCounterexampleGuidedRepair', payload),
  });
}

export function buildFormalProofStrategyPreparation({
  strategy,
  dsl,
  backend = 'lean',
  mathlibSymbolSearchReceipt = null,
  counterexampleSearchReceipts = [],
} = {}) {
  const descriptor = formalProofSearchStrategyDescriptor(strategy);
  if (!descriptor || dsl?.status !== 'typed_theorem_dsl_compiled'
    || dsl.machineSearchEligible !== true) {
    throw new Error('formal_proof_strategy_preparation_input_invalid');
  }
  const mathlibAuthorized = dsl.allowedImports.some((moduleName) => (
    moduleName === 'Mathlib' || moduleName.startsWith('Mathlib.')
  ));
  const requiredOperations = Object.freeze(descriptor.requiredOperations.filter((operation) => (
    mathlibAuthorized
      || !['pinned_mathlib_symbol_search', 'pinned_lemma_retrieval'].includes(operation)
  )));
  const formalProofBackendSelection = buildFormalProofBackendSelection({ backend });
  const goalDecomposition = buildGoalDecomposition(dsl);
  const lemmaRetrieval = buildLemmaRetrieval({
    requiredOperations,
    mathlibSymbolSearchReceipt,
  });
  const proofTermSynthesis = buildProofTermSynthesis({ descriptor, goalDecomposition });
  const counterexampleGuidedRepair = buildCounterexampleGuidedRepair({
    requiredOperations,
    counterexampleSearchReceipts: Array.isArray(counterexampleSearchReceipts)
      ? counterexampleSearchReceipts : [],
  });
  const blockers = Object.freeze([
    ...formalProofBackendSelection.blockers,
    ...lemmaRetrieval.blockers,
  ]);
  const payload = {
    version: 1,
    kind: 'FormalProofStrategyPreparation',
    status: blockers.length
      ? 'formal_proof_strategy_preparation_blocked'
      : 'formal_proof_strategy_preparation_ready',
    strategy,
    strategyOrdinal: descriptor.ordinal,
    requiredOperations,
    formalProofStrategyRegistryHash: FORMAL_PROOF_STRATEGY_REGISTRY_HASH,
    typedTheoremDslHash: dsl.typedTheoremDslHash,
    formalProofBackendSelection,
    goalDecomposition,
    lemmaRetrieval,
    proofTermSynthesis,
    counterexampleGuidedRepair,
    semanticBoundary: Object.freeze({
      independentSemanticReviewRequired: true,
      naturalLanguageToFormalEquivalenceEstablished: false,
      scientificTruthEstablished: false,
      openWorldTheoremDiscoveryGuaranteed: false,
    }),
    blockers,
  };
  return Object.freeze({
    ...payload,
    formalProofStrategyPreparationHash:
      hashRecord('FormalProofStrategyPreparation', payload),
  });
}

export function verifyFormalProofStrategyPreparation(preparation, inputs = {}) {
  let rebuilt = null;
  try { rebuilt = buildFormalProofStrategyPreparation(inputs); } catch {}
  return Boolean(rebuilt && JSON.stringify(preparation) === JSON.stringify(rebuilt));
}
