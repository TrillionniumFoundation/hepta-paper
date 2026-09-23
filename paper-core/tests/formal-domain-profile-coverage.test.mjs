import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFormalDomainQualificationTheoremSpecification,
  runConfiguredFormalDomainQualification,
} from '../../paper-composition/automation/formal-domain-qualification-composition.mjs';
import {
  buildFormalDomainCoverageReceipt,
  verifyFormalDomainCoverageReceipt,
} from '../../paper-adapters/research-verify/formal-domain-coverage-receipt.mjs';
import {
  FORMAL_DOMAIN_PROFILE_REGISTRY,
  REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
  verifyFormalDomainProfileRegistry,
} from '../../paper-domain/research/formal-domain-profile-registry.mjs';
import {
  buildTypedTheoremDslFromLeanType,
} from '../../paper-domain/research/typed-theorem-dsl.mjs';
import {
  createFormalProofSearchPlan,
  createTypedTheoremObligationBundle,
} from '../../paper-domain/research/typed-theorem-proof-search-contract.mjs';

test('five formal domain profiles compile non-reflexive Mathlib-bound typed DSL', () => {
  assert.equal(verifyFormalDomainProfileRegistry(FORMAL_DOMAIN_PROFILE_REGISTRY), true);
  assert.deepEqual(
    FORMAL_DOMAIN_PROFILE_REGISTRY.profiles.map((profile) => profile.profileId),
    REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
  );
  for (const profile of FORMAL_DOMAIN_PROFILE_REGISTRY.profiles) {
    const dsl = buildTypedTheoremDslFromLeanType({
      leanTypeSource: profile.leanTypeSource,
      allowedImports: profile.allowedImports,
    });
    assert.equal(dsl.status, 'typed_theorem_dsl_compiled', profile.profileId);
    assert.equal(dsl.machineSearchEligible, true, profile.profileId);
    assert.equal(dsl.compiledLeanTypeSource, profile.leanTypeSource, profile.profileId);
    assert.equal(dsl.typedTheoremDslHash, profile.typedTheoremDslHash, profile.profileId);
    assert.equal(profile.requiredProofSearchStrategy, 'mathlib_retrieval', profile.profileId);
    assert.doesNotMatch(profile.leanTypeSource, /\b([A-Za-z][A-Za-z0-9]*)\s*=\s*\1$/);
  }
});

test('qualification orchestrator builds one deterministic machine-search plan per profile', () => {
  for (const profile of FORMAL_DOMAIN_PROFILE_REGISTRY.profiles) {
    const theoremSpecification =
      buildFormalDomainQualificationTheoremSpecification(profile);
    const bundle = createTypedTheoremObligationBundle(theoremSpecification);
    const plan = createFormalProofSearchPlan(bundle);
    assert.equal(bundle.obligations.length, 1);
    assert.equal(bundle.obligations[0].typedTheoremDsl.machineSearchEligible, true);
    assert.equal(bundle.obligations[0].typedTheoremDsl.compiledLeanTypeSource,
      profile.leanTypeSource);
    assert.equal(plan.candidates.some((candidate) => (
      candidate.strategy === profile.requiredProofSearchStrategy
    )), true);
  }
});

test('qualification orchestrator refuses execution before configured external authority is valid', async () => {
  let called = false;
  await assert.rejects(() => runConfiguredFormalDomainQualification({
    dynamicFormalExecutionAuthority: null,
    formalProofSearchOperationsExecutor: {
      async execute() { called = true; return null; },
    },
  }), /dynamic_formal_execution_authority_required/);
  assert.equal(called, false);
});

test('Mathlib domain profiles fail closed without the Mathlib import', () => {
  for (const profile of FORMAL_DOMAIN_PROFILE_REGISTRY.profiles) {
    const dsl = buildTypedTheoremDslFromLeanType({
      leanTypeSource: profile.leanTypeSource,
      allowedImports: ['Init'],
    });
    assert.equal(dsl.status, 'typed_theorem_dsl_semantic_review_only', profile.profileId);
    assert.equal(dsl.machineSearchEligible, false, profile.profileId);
    assert.equal(dsl.semanticReviewOnlyReason,
      'typed_theorem_dsl_mathlib_domain_import_required', profile.profileId);
  }
});

test('formal domain coverage rejects empty, partial, duplicate, and self-shaped evidence', () => {
  const empty = buildFormalDomainCoverageReceipt({ evidencePackages: [] });
  assert.equal(empty.status, 'formal_domain_coverage_blocked');
  assert.equal(verifyFormalDomainCoverageReceipt(empty), false);
  assert.ok(empty.blockers.includes('formal_domain_coverage_profile_set_incomplete'));

  const selfShaped = REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS.map((profileId) => ({
    profileId,
    theoremSpecification: {},
    typedTheoremObligationBundle: {},
    formalProofSearchPlan: {},
    formalProofSearchCandidate: {},
    formalProofSearchOperationReceipt: {},
  }));
  const blocked = buildFormalDomainCoverageReceipt({ evidencePackages: selfShaped });
  assert.equal(blocked.status, 'formal_domain_coverage_blocked');
  assert.ok(blocked.blockers.includes('formal_domain_coverage_evidence_invalid'));
  assert.ok(blocked.blockers.includes(
    'formal_domain_coverage_execution_authority_inconsistent',
  ));
  assert.equal(verifyFormalDomainCoverageReceipt(blocked), false);

  const duplicate = buildFormalDomainCoverageReceipt({
    evidencePackages: [...selfShaped.slice(0, -1), selfShaped[0]],
  });
  assert.ok(duplicate.blockers.includes('formal_domain_coverage_profile_set_incomplete'));
});
