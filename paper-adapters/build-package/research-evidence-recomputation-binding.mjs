const FIELDS = Object.freeze([
  'independentRecomputationImplementationVerified',
  'recomputationIndependenceLevel',
  'rawEventRecomputationIndependenceContractHash',
  'recomputationProcessIndependent',
]);

export function researchEvidenceRecomputationIndependenceSummary(binding = {}) {
  return Object.freeze(Object.fromEntries(FIELDS.map((field) => [field, binding?.[field]])));
}

export function researchEvidenceRecomputationIndependenceMatches(observed, expected) {
  return FIELDS.every((field) => observed?.[field] === expected?.[field]);
}
