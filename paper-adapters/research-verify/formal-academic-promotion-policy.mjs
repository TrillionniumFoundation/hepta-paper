import { verifyFormalClaimContract } from '../../paper-domain/research/formal-claim-contract.mjs';
import { formalAxiomPolicyBlockers } from '../../paper-domain/research/formal-verifier-policy.mjs';
import {
  autonomousFormalLeanTypeContractForObligation,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import { leanTypeIdentity } from '../../paper-domain/research/lean-type-identity.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EXACT_TYPE_AUTHORITY_KINDS = new Set([
  'dynamic_typed_seed',
  'system_registry_verified_ir',
]);
const FORMAL_TYPE_AUTHORITY_KEYS = Object.freeze([
  'authorityKind', 'authorityRecordHash', 'authoritativeTheoremName',
  'authoritativeTypeHash', 'formalTypeAuthorityBindingHash',
  'independentOfAuthorDeclaration', 'kind', 'machineClosedLoopPromotionAllowed',
  'observedAuthorDeclarationTypeHash', 'status', 'version',
]);

function formalTypeAuthorityBlockers(binding) {
  const authority = binding?.formalTypeAuthority || null;
  if (!authority) {
    return binding?.theoremSpecificationHash
      ? ['formal_exact_type_authority_required'] : [];
  }
  const { formalTypeAuthorityBindingHash: claimedHash, ...payload } = authority;
  const blockers = [];
  if (!hasExactObjectKeys(authority, FORMAL_TYPE_AUTHORITY_KEYS)
    || authority.version !== 1 || authority.kind !== 'FormalTypeAuthorityBinding'
    || claimedHash !== hashRecord('FormalTypeAuthorityBinding', payload)) {
    blockers.push('formal_type_authority_binding_hash_invalid');
  }
  const dynamicAuthority = binding?.formalClaimContract?.dynamicFormalClaimAuthority || null;
  const proofObligations = binding?.proofObligations || binding?.obligationNames || [];
  const registryContract = proofObligations.length === 1
    ? autonomousFormalLeanTypeContractForObligation(proofObligations[0]) : null;
  const registryTypeHash = registryContract
    ? leanTypeIdentity(registryContract.expectedType).normalizedTypeHash : null;
  const authoritySourceValid = authority.authorityKind === 'dynamic_typed_seed'
    ? (dynamicAuthority?.dynamicFormalClaimSeedHash === authority.authorityRecordHash
      && dynamicAuthority?.leanDeclarationName === authority.authoritativeTheoremName
      && dynamicAuthority?.leanNormalizedTypeHash === authority.authoritativeTypeHash)
    : authority.authorityKind === 'system_registry_verified_ir'
      ? (registryContract?.autonomousFormalLeanTypeContractHash
        === authority.authorityRecordHash
        && registryContract?.canonicalTheoremName === authority.authoritativeTheoremName
        && registryTypeHash === authority.authoritativeTypeHash)
      : false;
  const exactAuthority = authority.status === 'formal_exact_type_authority_verified'
    && EXACT_TYPE_AUTHORITY_KINDS.has(authority.authorityKind)
    && authoritySourceValid
    && SHA256.test(String(authority.authorityRecordHash || ''))
    && authority.authoritativeTheoremName === binding?.theoremName
    && authority.authoritativeTypeHash === binding?.expectedTypeHash
    && authority.observedAuthorDeclarationTypeHash === binding?.expectedTypeHash
    && authority.independentOfAuthorDeclaration === true
    && authority.machineClosedLoopPromotionAllowed === true
    && binding?.formalizationMode === 'independent_exact_type_authority'
    && binding?.machineClosedLoopPromotionAllowed === true;
  const semanticOnly = authority.status === 'formal_exact_type_authority_unavailable'
    && authority.authorityKind === 'semantic_review_only_author_declaration'
    && authority.authorityRecordHash === null
    && authority.authoritativeTheoremName === null
    && authority.authoritativeTypeHash === null
    && authority.observedAuthorDeclarationTypeHash === binding?.expectedTypeHash
    && authority.independentOfAuthorDeclaration === false
    && authority.machineClosedLoopPromotionAllowed === false
    && binding?.formalizationMode
      === 'semantic_review_only_no_independent_exact_type_authority'
    && binding?.machineClosedLoopPromotionAllowed === false;
  if (!exactAuthority && !semanticOnly) blockers.push('formal_type_authority_binding_invalid');
  if (semanticOnly) blockers.push('formal_semantic_only_machine_closed_loop_promotion_forbidden');
  return blockers;
}

export function formalAcademicPromotionBlockers(worker = {}, result = {}) {
  if (worker.type === 'formal_verifier_lean') return ['formal_promotion_requires_lake_verifier'];
  if (worker.type !== 'formal_verifier_lake') return [];
  const blockers = [];
  const claimBindings = Array.isArray(worker.parameters?.claimBindings)
    ? worker.parameters.claimBindings : [];
  blockers.push(...formalAxiomPolicyBlockers(worker.parameters?.allowedAxioms));
  if (!claimBindings.length) blockers.push('formal_claim_bindings_required_for_academic_evidence');
  if (result.status !== 'formal_claim_verified') {
    blockers.push(`formal_claim_verification_required:${result.status || 'missing'}`);
  }
  if (result.replayReceipt?.status !== 'formal_claim_replay_verified'
    || !result.formalCertificateReplayReceiptHash) {
    blockers.push('formal_claim_independent_replay_required');
  }
  const declaredClaimIds = new Set((worker.claimIds || []).map(String));
  for (const binding of claimBindings) {
    if (!binding?.claimId || !declaredClaimIds.has(String(binding.claimId))) {
      blockers.push(`formal_claim_binding_worker_claim_mismatch:${binding?.claimId || 'missing'}`);
    }
    blockers.push(...formalTypeAuthorityBlockers(binding)
      .map((item) => `${binding?.claimId || 'missing'}:${item}`));
    const contractVerification = verifyFormalClaimContract(binding?.formalClaimContract, {
      claimId: binding?.claimId,
      manuscriptClaimHash: binding?.manuscriptClaimHash,
      theoremName: binding?.theoremName,
      theoremTypeHash: binding?.expectedTypeHash,
      sourceStatementHash: binding?.sourceStatementHash,
      proofObligations: binding?.proofObligations || binding?.obligationNames,
      proofObligationContracts: binding?.proofObligationContracts,
      proofObligationMappings: binding?.proofObligationMappings,
      theoremSpecificationHash: binding?.theoremSpecificationHash,
      theoremSpecificationClaimHash: binding?.theoremSpecificationClaimHash,
      proposalClaimToTheoremBindingHash: binding?.proposalClaimToTheoremBindingHash,
      proposalClaimRecordHash: binding?.proposalClaimRecordHash,
    });
    blockers.push(...contractVerification.blockers
      .map((item) => `${binding?.claimId || 'missing'}:${item}`));
  }
  return [...new Set(blockers)];
}
