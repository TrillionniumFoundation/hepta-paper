import { verifyFormalClaimContract } from '../../paper-domain/research/formal-claim-contract.mjs';
import { formalAxiomPolicyBlockers } from '../../paper-domain/research/formal-verifier-policy.mjs';

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
