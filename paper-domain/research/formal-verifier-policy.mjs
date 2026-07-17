export const SYSTEM_ALLOWED_FORMAL_AXIOMS = Object.freeze([]);
export const PRODUCTION_LEAN_TOOLCHAIN = 'leanprover/lean4:v4.30.0';
// Reviewed content root of the pinned upstream Lean distribution. Runtime
// measurement alone is not authority: a modified kernel must fail against an
// independently versioned trust anchor before it can issue certificates.
export const PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES = Object.freeze({
  [PRODUCTION_LEAN_TOOLCHAIN]: 'sha256:a0d6d66cf58068c29c5330136a1577e3706b62ea1596dc1b93e55a83a2fb8f75',
});

export const FORMAL_ASSURANCE_LADDER = Object.freeze({
  singleFileLean: Object.freeze({
    assuranceLevel: 'syntax_smoke_only',
    academicPromotionEligible: false,
    promotionScope: 'none',
  }),
  lakeClaimReplay: Object.freeze({
    assuranceLevel: 'lean_lake_claim_and_replay_authority',
    workerType: 'formal_verifier_lake',
    requiredVerificationStatus: 'formal_claim_verified',
    requiredReplayStatus: 'formal_claim_replay_verified',
    academicPromotionEligible: true,
    promotionScope: 'academic_formal_claim',
  }),
  coq: Object.freeze({
    assuranceLevel: 'unavailable',
    academicPromotionEligible: false,
    promotionScope: 'none',
  }),
  isabelle: Object.freeze({
    assuranceLevel: 'unavailable',
    academicPromotionEligible: false,
    promotionScope: 'none',
  }),
});

export function formalAxiomPolicyBlockers(requested = []) {
  const allowed = new Set(SYSTEM_ALLOWED_FORMAL_AXIOMS);
  return [...new Set((Array.isArray(requested) ? requested : []).map(String))]
    .filter((axiom) => !allowed.has(axiom))
    .map((axiom) => `formal_caller_axiom_allowlist_forbidden:${axiom}`);
}
