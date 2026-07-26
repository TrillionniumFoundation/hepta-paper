export const SYSTEM_ALLOWED_FORMAL_AXIOMS = Object.freeze([]);
export const PRODUCTION_LEAN_TOOLCHAIN = 'leanprover/lean4:v4.30.0';
// Reviewed content root of the pinned upstream Lean distribution. Runtime
// measurement alone is not authority: a modified kernel must fail against an
// independently versioned trust anchor before it can issue certificates.
export const PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES = Object.freeze({
  [PRODUCTION_LEAN_TOOLCHAIN]: 'sha256:a0d6d66cf58068c29c5330136a1577e3706b62ea1596dc1b93e55a83a2fb8f75',
});

// This is a code-reviewed upstream release anchor, not deployment-supplied
// metadata.  A local package that merely calls itself `mathlib`, or a closure
// hash chosen by the same deployment, must not become production authority.
// The Git tree is bound as well as the tag commit so that provenance checks do
// not reduce to trusting a mutable tag name.
export const PRODUCTION_MATHLIB_RELEASES = Object.freeze({
  [PRODUCTION_LEAN_TOOLCHAIN]: Object.freeze({
    manifestVersion: '1.2.0',
    packagesDir: '.lake/packages',
    releaseTag: 'v4.30.0',
    repositoryUrl: 'https://github.com/leanprover-community/mathlib4',
    revision: 'c5ea00351c28e24afc9f0f84379aa41082b1188f',
    sourceTreeHash: '1fe688f4d9e84fb268a300f8ac33cbca883fbd28',
    packageEntry: Object.freeze({
      type: 'git',
      url: 'https://github.com/leanprover-community/mathlib4',
      subDir: null,
      scope: 'leanprover-community',
      rev: 'c5ea00351c28e24afc9f0f84379aa41082b1188f',
      name: 'mathlib',
      manifestFile: 'lake-manifest.json',
      inputRev: 'v4.30.0',
      inherited: false,
      configFile: 'lakefile.lean',
    }),
  }),
});

// Populated only after an official-source Mathlib bundle has been independently
// reviewed. The Lean 4.30 entry binds the immutable service-owned closure at
// /srv/hepta-paper/formal/mathlib-project: 119,871 files, official Mathlib
// commit/tree above, no writable/symlink/hardlink/special entries, and a
// successful service-principal Real-number probe. It is a reviewed byte-closure
// authorization, not a claim of two independent bit-for-bit builds.
// A deployment-provided closure hash is an expectation, not an authorization,
// and therefore cannot populate this map.
export const PRODUCTION_MATHLIB_BUILD_CLOSURE_HASHES = Object.freeze({
  [PRODUCTION_LEAN_TOOLCHAIN]: Object.freeze([
    'sha256:64b07e1b11ec2f87168612b964d84e350ab9e6e88129397a21694689b24f8412',
  ]),
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
