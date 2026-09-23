export const TRUSTED_AUTONOMOUS_MANUSCRIPT_TITLE = 'Autonomous bounded research report';

export const TRUSTED_AUTONOMOUS_MANUSCRIPT_SECTIONS = Object.freeze([
  'Abstract',
  'Research scope',
  'Related-work boundary',
  'Methods',
  'Preregistered claims',
  'Formal assurance',
  'Results',
  'Discussion',
  'Reproducibility and audit trail',
  'Limitations',
  'Conclusion',
]);

export const TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE = Object.freeze({
  abstract: 'This article reports a preregistered, bounded evaluation. All quantitative statements are rendered from verified experiment authority, and the formal result is limited to its kernel-checked statement.',
  scope: 'The machine-selected agenda is evaluated only inside its registered benchmark universe. Treatment, baseline, ablation, exclusions, metrics, and replay requirements are fixed before result promotion.',
  relatedWork: 'Prior-art qualification is a separate release-bound authority. This source manuscript does not claim that a search is complete, nor does it infer novelty from the absence of a match.',
  methods: 'The evaluation uses a predeclared treatment, baseline, and ablation schedule. Agent-generated aggregates are not accepted as statistical authority; accepted statements must bind to repository-recomputed raw evidence and a matching isolated deterministic rerun.',
  formal: 'The formal artifact supports a protocol invariant only. It is not used as an axiom for the empirical result and does not establish external validity or scientific novelty.',
  discussion: 'Interpretation is restricted to the registered population, metrics, comparators, and accepted typed assertions above. No unregistered causal, universal, convergence, or superiority claim is introduced by this section.',
  reproducibility: 'The release evidence binds code, dataset authority, runtime identity, analysis protocol, raw events, original execution, isolated deterministic rerun, and the rendered result surfaces by hash.',
  limitations: 'This report is limited to registered typed assertions and the kernel-verified formal statement. The rerun uses the same hash-bound code, image, data, and harness and is not independent scientific replication. Scientific novelty, universal correctness, natural-language-to-Lean semantic equivalence, and independent external replication are not implied by successful execution.',
  conclusion: 'The evidence package records whether the preregistered claims satisfied their declared acceptance rules. Broader conclusions require separately registered evidence.',
});
