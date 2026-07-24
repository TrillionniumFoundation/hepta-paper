import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyTheoremSpecification } from './theorem-specification.mjs';
import { buildTypedTheoremDslFromLeanType } from './typed-theorem-dsl.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OBLIGATION_KEYS = Object.freeze([
  'allowedImports', 'assumptionSetHash', 'claimId', 'claimKey', 'goalAuthority',
  'formalizationMode', 'kernelVerificationRequired', 'kind', 'leanDeclarationName', 'leanNormalizedTypeHash',
  'leanTypeSourceHash', 'negativeBoundarySetHash', 'naturalLanguageEquivalenceReviewRequired',
  'proofObligationContracts', 'quantifierSetHash', 'status', 'theoremSpecificationClaimHash',
  'typedTheoremDsl', 'typedTheoremDslHash', 'typedTheoremObligationHash', 'version',
]);
const BUNDLE_KEYS = Object.freeze([
  'claimCount', 'kind', 'limitations', 'obligations', 'status',
  'theoremSpecificationHash', 'typedTheoremObligationBundleHash', 'version',
]);
const PLAN_KEYS = Object.freeze([
  'candidateCount', 'candidates', 'exhaustionPolicy', 'kind', 'limitations',
  'status', 'successPolicy', 'theoremSpecificationHash',
  'typedTheoremObligationBundleHash', 'formalProofSearchPlanHash', 'version',
]);

const SEARCH_STRATEGIES = Object.freeze([
  Object.freeze({
    ordinal: 0,
    strategy: 'direct_elaboration',
    requiredOperations: Object.freeze(['lean_elaboration', 'proof_state_inspection']),
    counterexampleDisposition: 'not_requested',
  }),
  Object.freeze({
    ordinal: 1,
    strategy: 'mathlib_retrieval',
    requiredOperations: Object.freeze([
      'lean_elaboration', 'proof_state_inspection', 'pinned_mathlib_symbol_search',
    ]),
    counterexampleDisposition: 'not_requested',
  }),
  Object.freeze({
    ordinal: 2,
    strategy: 'bounded_refutation_or_synthesis',
    requiredOperations: Object.freeze([
      'lean_elaboration', 'proof_state_inspection', 'pinned_mathlib_symbol_search',
      'bounded_counterexample_search',
    ]),
    counterexampleDisposition: 'bounded_search_inconclusive',
  }),
]);

function exactHash(value, code) {
  const hash = String(value || '').toLowerCase();
  if (!SHA256.test(hash)) throw new Error(code);
  return hash;
}

function textSetHash(kind, values) {
  if (!Array.isArray(values)) throw new Error('typed_theorem_obligation_text_set_invalid');
  return hashRecord(kind, values.map((value) => String(value)));
}

function canonicalObligation(claim) {
  const dynamicAuthority = claim?.proposalClaimSource?.dynamicFormalClaimSeedHash
    ? claim.proposalClaimSource : null;
  const contracts = Array.isArray(claim?.proofObligationContracts)
    ? claim.proofObligationContracts.map((contract) => Object.freeze({
      obligationId: String(contract?.obligationId || ''),
      displayTextHash: hashBytes(Buffer.from(String(contract?.displayText || ''), 'utf8')),
    })) : [];
  if (!claim?.claimId || !claim?.claimKey || !contracts.length
    || contracts.some((contract) => !/^obligation:[0-9a-f]{64}$/.test(contract.obligationId))) {
    throw new Error('typed_theorem_obligation_claim_invalid');
  }
  const typedTheoremDsl = buildTypedTheoremDslFromLeanType({
    leanTypeSource: dynamicAuthority?.leanTypeSource || '',
    leanTypeSourceHash: dynamicAuthority?.leanTypeSourceHash || null,
    leanNormalizedTypeHash: dynamicAuthority?.leanNormalizedTypeHash || null,
    allowedImports: dynamicAuthority?.allowedImports || [],
  });
  const payload = {
    version: 1,
    kind: 'TypedTheoremObligation',
    status: 'typed_theorem_obligation_ready',
    claimId: String(claim.claimId),
    claimKey: String(claim.claimKey),
    theoremSpecificationClaimHash: exactHash(
      claim.theoremSpecificationClaimHash,
      'typed_theorem_obligation_claim_hash_invalid',
    ),
    goalAuthority: dynamicAuthority ? 'exact_dynamic_lean_type' : 'semantic_review_required',
    leanDeclarationName: dynamicAuthority?.leanDeclarationName || null,
    leanTypeSourceHash: dynamicAuthority?.leanTypeSourceHash || null,
    leanNormalizedTypeHash: dynamicAuthority?.leanNormalizedTypeHash || null,
    allowedImports: dynamicAuthority
      ? Object.freeze([...dynamicAuthority.allowedImports]) : null,
    formalizationMode: dynamicAuthority
      ? typedTheoremDsl.machineSearchEligible
        ? 'machine_compiled_typed_dsl'
        : 'semantic_review_only_unsupported_dsl'
      : 'semantic_review_only_no_exact_type_authority',
    typedTheoremDsl,
    typedTheoremDslHash: typedTheoremDsl.typedTheoremDslHash,
    assumptionSetHash: textSetHash('TypedTheoremAssumptionSet', claim.assumptions),
    quantifierSetHash: textSetHash('TypedTheoremQuantifierSet', claim.quantifiers),
    negativeBoundarySetHash: textSetHash(
      'TypedTheoremNegativeBoundarySet',
      claim.negativeBoundaries,
    ),
    proofObligationContracts: Object.freeze(contracts),
    naturalLanguageEquivalenceReviewRequired: true,
    kernelVerificationRequired: true,
  };
  return Object.freeze({
    ...payload,
    typedTheoremObligationHash: hashRecord('TypedTheoremObligation', payload),
  });
}

export function createTypedTheoremObligationBundle(theoremSpecification) {
  const verification = verifyTheoremSpecification(theoremSpecification);
  if (!verification.valid) throw new Error('typed_theorem_obligation_theorem_specification_invalid');
  const obligations = Object.freeze(theoremSpecification.claims.map(canonicalObligation));
  const payload = {
    version: 1,
    kind: 'TypedTheoremObligationBundle',
    status: 'typed_theorem_obligation_bundle_ready',
    theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
    claimCount: obligations.length,
    obligations,
    limitations: Object.freeze({
      openWorldTheoremDiscoveryGuaranteed: false,
      scientificTruthGuaranteed: false,
      naturalLanguageToLeanEquivalenceKernelProven: false,
      counterexampleAbsenceEstablishesTruth: false,
    }),
  };
  return Object.freeze({
    ...payload,
    typedTheoremObligationBundleHash: hashRecord('TypedTheoremObligationBundle', payload),
  });
}

export function verifyTypedTheoremObligationBundle(bundle, { theoremSpecification } = {}) {
  const blockers = [];
  if (!hasExactObjectKeys(bundle, BUNDLE_KEYS)) blockers.push('typed_theorem_obligation_bundle_shape_invalid');
  let rebuilt = null;
  try { rebuilt = createTypedTheoremObligationBundle(theoremSpecification); }
  catch { blockers.push('typed_theorem_obligation_bundle_rebuild_failed'); }
  if (!rebuilt || JSON.stringify(bundle) !== JSON.stringify(rebuilt)) {
    blockers.push('typed_theorem_obligation_bundle_not_canonical');
  }
  if (Array.isArray(bundle?.obligations)
    && bundle.obligations.some((obligation) => !hasExactObjectKeys(obligation, OBLIGATION_KEYS))) {
    blockers.push('typed_theorem_obligation_shape_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'typed_theorem_obligation_bundle_blocked'
      : 'typed_theorem_obligation_bundle_verified',
    typedTheoremObligationBundleHash: bundle?.typedTheoremObligationBundleHash || null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function canonicalSearchCandidate({ planAuthority, strategy }) {
  const payload = {
    version: 1,
    kind: 'FormalProofSearchCandidate',
    ordinal: strategy.ordinal,
    strategy: strategy.strategy,
    requiredOperations: strategy.requiredOperations,
    counterexampleDispositionOnFailure: strategy.counterexampleDisposition,
    theoremSpecificationHash: planAuthority.theoremSpecificationHash,
    typedTheoremObligationBundleHash: planAuthority.typedTheoremObligationBundleHash,
    claimMutationAllowed: false,
    unpinnedNetworkRetrievalAllowed: false,
  };
  return Object.freeze({
    ...payload,
    candidateId: `proof-candidate:${hashRecord('FormalProofSearchCandidate', payload).slice('sha256:'.length)}`,
  });
}

export function createFormalProofSearchPlan(bundle) {
  if (!bundle || bundle.kind !== 'TypedTheoremObligationBundle'
    || bundle.status !== 'typed_theorem_obligation_bundle_ready'
    || !SHA256.test(String(bundle.typedTheoremObligationBundleHash || ''))) {
    throw new Error('formal_proof_search_obligation_bundle_invalid');
  }
  const authority = Object.freeze({
    theoremSpecificationHash: exactHash(
      bundle.theoremSpecificationHash,
      'formal_proof_search_theorem_specification_hash_invalid',
    ),
    typedTheoremObligationBundleHash: exactHash(
      bundle.typedTheoremObligationBundleHash,
      'formal_proof_search_obligation_bundle_hash_invalid',
    ),
  });
  const machineEligibleObligations = bundle.obligations.filter((obligation) => (
    obligation.typedTheoremDsl?.machineSearchEligible === true
  ));
  const mathlibAuthorized = !machineEligibleObligations.length
    || machineEligibleObligations.some((obligation) => (
    obligation.typedTheoremDsl?.machineSearchEligible === true
      && obligation.typedTheoremDsl.allowedImports.includes('Mathlib')
    ));
  const strategies = SEARCH_STRATEGIES.map((strategy) => Object.freeze({
    ...strategy,
    requiredOperations: mathlibAuthorized
      ? strategy.requiredOperations
      : Object.freeze(strategy.requiredOperations.filter((operation) => (
        operation !== 'pinned_mathlib_symbol_search'
      ))),
  }));
  const candidates = Object.freeze(strategies.map((strategy) => (
    canonicalSearchCandidate({ planAuthority: authority, strategy })
  )));
  const payload = {
    version: 1,
    kind: 'FormalProofSearchPlan',
    status: 'formal_proof_search_plan_ready',
    ...authority,
    candidateCount: candidates.length,
    candidates,
    successPolicy: 'independent_semantic_review_kernel_axiom_audit_fresh_replay',
    exhaustionPolicy: 'emit_hash_bound_failure_certificate',
    limitations: bundle.limitations,
  };
  return Object.freeze({
    ...payload,
    formalProofSearchPlanHash: hashRecord('FormalProofSearchPlan', payload),
  });
}

export function verifyFormalProofSearchPlan(plan, { bundle } = {}) {
  const blockers = [];
  if (!hasExactObjectKeys(plan, PLAN_KEYS)) blockers.push('formal_proof_search_plan_shape_invalid');
  let rebuilt = null;
  try { rebuilt = createFormalProofSearchPlan(bundle); }
  catch { blockers.push('formal_proof_search_plan_rebuild_failed'); }
  if (!rebuilt || JSON.stringify(plan) !== JSON.stringify(rebuilt)) {
    blockers.push('formal_proof_search_plan_not_canonical');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length ? 'formal_proof_search_plan_blocked' : 'formal_proof_search_plan_verified',
    formalProofSearchPlanHash: plan?.formalProofSearchPlanHash || null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function createFormalProofSearchAttemptReceipt({
  plan,
  candidate,
  authorAgentReceiptHash,
  reviewAgentReceiptHash,
  formalReviewEnvelopeHash,
  campaignFormalVerificationReceiptHash,
  formalProofSearchOperationReceipt = null,
  blockers,
} = {}) {
  const ordinal = Number(candidate?.ordinal);
  const selectedBlockers = Array.isArray(blockers)
    ? Object.freeze([...new Set(blockers.map(String).filter(Boolean))].sort()) : Object.freeze([]);
  if (!plan || candidate !== plan.candidates?.[ordinal] || !selectedBlockers.length
    || ![
      authorAgentReceiptHash,
      reviewAgentReceiptHash,
      formalReviewEnvelopeHash,
    ].every((hash) => SHA256.test(String(hash || '')))) {
    throw new Error('formal_proof_search_attempt_invalid');
  }
  const verificationReceiptHash = campaignFormalVerificationReceiptHash === null
    || campaignFormalVerificationReceiptHash === undefined
    ? null : String(campaignFormalVerificationReceiptHash);
  if (verificationReceiptHash !== null && !SHA256.test(verificationReceiptHash)) {
    throw new Error('formal_proof_search_attempt_invalid');
  }
  const operationReceiptHash = formalProofSearchOperationReceipt
    ?.formalProofSearchOperationReceiptHash
    || formalProofSearchOperationReceipt
      ?.formalTheoremDependencyGraphOperationReceiptHash
    || null;
  if (operationReceiptHash !== null && !SHA256.test(String(operationReceiptHash))) {
    throw new Error('formal_proof_search_attempt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'FormalProofSearchAttemptReceipt',
    status: 'formal_proof_search_candidate_rejected',
    formalProofSearchPlanHash: plan.formalProofSearchPlanHash,
    candidateId: candidate.candidateId,
    candidateOrdinal: ordinal,
    strategy: candidate.strategy,
    authorAgentReceiptHash,
    reviewAgentReceiptHash,
    formalReviewEnvelopeHash,
    campaignFormalVerificationReceiptHash: verificationReceiptHash,
    formalProofSearchOperationReceiptHash: operationReceiptHash,
    formalProofSearchOperationReceipt,
    counterexampleDisposition: candidate.counterexampleDispositionOnFailure,
    blockers: selectedBlockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    formalProofSearchAttemptReceiptHash: hashRecord('FormalProofSearchAttemptReceipt', payload),
  });
}

export function verifyFormalProofSearchAttempts(attempts, { plan, expectedCount } = {}) {
  const blockers = [];
  const records = Array.isArray(attempts) ? attempts : [];
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0
    || records.length !== expectedCount) {
    blockers.push('formal_proof_search_attempt_count_invalid');
  }
  records.forEach((record, index) => {
    let rebuilt = null;
    try {
      rebuilt = createFormalProofSearchAttemptReceipt({
        plan,
        candidate: plan?.candidates?.[index],
        authorAgentReceiptHash: record?.authorAgentReceiptHash,
        reviewAgentReceiptHash: record?.reviewAgentReceiptHash,
        formalReviewEnvelopeHash: record?.formalReviewEnvelopeHash,
        campaignFormalVerificationReceiptHash: record?.campaignFormalVerificationReceiptHash,
        formalProofSearchOperationReceipt: record?.formalProofSearchOperationReceipt || null,
        blockers: record?.blockers,
      });
    } catch { blockers.push(`formal_proof_search_attempt_${index}_rebuild_failed`); }
    if (!rebuilt || JSON.stringify(record) !== JSON.stringify(rebuilt)) {
      blockers.push(`formal_proof_search_attempt_${index}_invalid`);
    }
  });
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'formal_proof_search_attempts_blocked'
      : 'formal_proof_search_attempts_verified',
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function createFormalProofSearchFailureCertificate({ plan, attempts } = {}) {
  const verification = verifyFormalProofSearchAttempts(attempts, {
    plan,
    expectedCount: plan?.candidateCount,
  });
  if (!verification.valid || attempts.at(-1)?.candidateOrdinal !== plan.candidateCount - 1) {
    throw new Error('formal_proof_search_failure_certificate_attempts_invalid');
  }
  const payload = {
    version: 1,
    kind: 'FormalProofSearchFailureCertificate',
    status: 'formal_proof_search_exhausted',
    theoremSpecificationHash: plan.theoremSpecificationHash,
    typedTheoremObligationBundleHash: plan.typedTheoremObligationBundleHash,
    formalProofSearchPlanHash: plan.formalProofSearchPlanHash,
    attemptReceiptHashes: Object.freeze(attempts.map((attempt) => (
      attempt.formalProofSearchAttemptReceiptHash
    ))),
    attempts: Object.freeze([...attempts]),
    kernelProofStatus: 'not_established',
    counterexampleStatus: 'not_established',
    limitations: plan.limitations,
    blockers: Object.freeze(['formal_proof_search_exhausted_without_kernel_verified_candidate']),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    formalProofSearchFailureCertificateHash:
      hashRecord('FormalProofSearchFailureCertificate', payload),
  });
}
