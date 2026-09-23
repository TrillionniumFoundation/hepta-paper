import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildTypedTheoremDslFromLeanType } from './typed-theorem-dsl.mjs';

export const REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS = Object.freeze([
  'matrix-real-fixed-dimension-v1',
  'measure-finite-carrier-v1',
  'optimization-feasible-set-real-v1',
  'stochastic-process-finite-state-v1',
  'vector-real-fixed-dimension-v1',
]);

const DEFINITIONS = Object.freeze([
  Object.freeze({
    profileId: 'vector-real-fixed-dimension-v1',
    domain: 'Vector',
    fragment: 'fixed-dimension-additive-identity-v2',
    leanTypeSource: '∀ x : Vector Real 3, x + 0 = x',
    requiredProofSearchStrategy: 'mathlib_retrieval',
  }),
  Object.freeze({
    profileId: 'matrix-real-fixed-dimension-v1',
    domain: 'Matrix',
    fragment: 'fixed-dimension-additive-identity-v2',
    leanTypeSource: '∀ A : Matrix (Fin 2) (Fin 3) Real, A + 0 = A',
    requiredProofSearchStrategy: 'mathlib_retrieval',
  }),
  Object.freeze({
    profileId: 'measure-finite-carrier-v1',
    domain: 'Measure',
    fragment: 'finite-carrier-measure-additive-identity-v2',
    leanTypeSource: '∀ mu : MeasureTheory.Measure Bool, mu + 0 = mu',
    requiredProofSearchStrategy: 'mathlib_retrieval',
  }),
  Object.freeze({
    profileId: 'optimization-feasible-set-real-v1',
    domain: 'OptimizationFeasibleSet',
    fragment: 'real-feasible-set-universal-intersection-v2',
    leanTypeSource: '∀ feasible : Set Real, feasible ∩ Set.univ = feasible',
    requiredProofSearchStrategy: 'mathlib_retrieval',
  }),
  Object.freeze({
    profileId: 'stochastic-process-finite-state-v1',
    domain: 'StochasticProcess',
    fragment: 'nat-indexed-finite-state-real-process-additive-identity-v2',
    leanTypeSource: '∀ process : Nat → Bool → Real, process + 0 = process',
    requiredProofSearchStrategy: 'mathlib_retrieval',
  }),
]);

function buildProfile(definition) {
  const typedTheoremDsl = buildTypedTheoremDslFromLeanType({
    leanTypeSource: definition.leanTypeSource,
    allowedImports: ['Mathlib'],
  });
  if (typedTheoremDsl.status !== 'typed_theorem_dsl_compiled'
    || typedTheoremDsl.machineSearchEligible !== true) {
    throw new Error('formal_domain_profile_dsl_not_machine_searchable');
  }
  const payload = {
    version: 1,
    kind: 'FormalDomainProfile',
    ...definition,
    allowedImports: Object.freeze(['Mathlib']),
    typedTheoremDslHash: typedTheoremDsl.typedTheoremDslHash,
    leanNormalizedTypeHash: typedTheoremDsl.sourceLeanNormalizedTypeHash,
    coverageClaim: 'diagnostic-kernel-elaboration-and-fresh-replay-only-v1',
    theoremDiscoveryGuaranteed: false,
    domainCompletenessClaimed: false,
  };
  return Object.freeze({
    ...payload,
    formalDomainProfileHash: hashRecord('FormalDomainProfile', payload),
  });
}

const profiles = Object.freeze(DEFINITIONS.map(buildProfile)
  .sort((left, right) => left.profileId.localeCompare(right.profileId)));
const registryPayload = {
  version: 1,
  kind: 'FormalDomainProfileRegistry',
  profiles,
  requiredProfileIds: REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
};

export const FORMAL_DOMAIN_PROFILE_REGISTRY = Object.freeze({
  ...registryPayload,
  formalDomainProfileRegistryHash:
    hashRecord('FormalDomainProfileRegistry', registryPayload),
});

export function formalDomainProfileFor(profileId) {
  return profiles.find((profile) => profile.profileId === profileId) || null;
}

export function verifyFormalDomainProfileRegistry(value) {
  try {
    return JSON.stringify(value) === JSON.stringify(FORMAL_DOMAIN_PROFILE_REGISTRY);
  } catch {
    return false;
  }
}
