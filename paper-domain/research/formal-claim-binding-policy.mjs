import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyFormalClaimContract } from './formal-claim-contract.mjs';
import { normalizeFormalProofObligationMappings } from './formal-proof-obligation-mapping.mjs';

export function evaluateFormalClaimBindings({ claims = [], declarations = [], allowedAxioms = [] } = {}) {
  const declarationByName = new Map((Array.isArray(declarations) ? declarations : []).map((item) => [item.name, item]));
  const allowed = new Set(allowedAxioms);
  const blockers = [];
  const bindings = (Array.isArray(claims) ? claims : []).map((claim) => {
    const declaration = declarationByName.get(claim.theoremName) || null;
    const issues = [];
    if (!claim.claimId) issues.push('claim_id_missing');
    if (!claim.expectedTypeHash) issues.push('claim_expected_type_hash_missing');
    if (!claim.sourceStatementHash) issues.push('claim_source_statement_hash_missing');
    if (!declaration) issues.push('target_theorem_missing');
    if (declaration && claim.expectedTypeHash && declaration.typeHash !== claim.expectedTypeHash) issues.push('target_theorem_type_hash_mismatch');
    if (claim.sourceStatementHash && declaration?.sourceStatementHash !== claim.sourceStatementHash) issues.push('target_theorem_source_statement_hash_mismatch');
    if (declaration && declaration.buildVerified !== true) issues.push('target_theorem_build_not_verified');
    if (declaration?.hasSorry) issues.push('target_theorem_contains_sorry');
    if (declaration?.hasAdmit) issues.push('target_theorem_contains_admit');
    const unexpectedAxioms = (declaration?.axioms || []).filter((axiom) => !allowed.has(axiom));
    if (unexpectedAxioms.length) issues.push('target_theorem_uses_unapproved_axioms');
    if (declaration?.conclusionAssumedAsPremise === true) issues.push('target_conclusion_assumed_as_premise');
    if (declaration?.vacuous === true || declaration?.conclusion === 'True') issues.push('target_theorem_vacuous_true');
    if (claim.unconditional === true && declaration?.conditional === true) issues.push('conditional_theorem_bound_to_unconditional_claim');
    const proofObligations = [...new Set(claim.proofObligations || claim.obligationNames || [])];
    const obligationMapping = normalizeFormalProofObligationMappings({
      proofObligationContracts: claim.proofObligationContracts,
      proofObligations: claim.proofObligations || claim.obligationNames,
      proofObligationMappings: claim.proofObligationMappings,
      theoremName: claim.theoremName,
    });
    issues.push(...obligationMapping.blockers);
    if (!proofObligations.length) issues.push('claim_proof_obligations_missing');
    const relevantDeclarations = obligationMapping.verificationTargets
      .map((name) => declarationByName.get(name))
      .filter(Boolean);
    const verifiedObligations = [...new Set(relevantDeclarations
      .flatMap((item) => item.verifiedObligations || []))].sort();
    for (const mapping of obligationMapping.mappings) {
      const mappedDeclarations = mapping.leanDeclarations
        .map((name) => declarationByName.get(name))
        .filter(Boolean);
      const covered = mappedDeclarations.some((item) => item.buildVerified === true
        && item.hasSorry !== true && item.hasAdmit !== true
        && item.conclusionAssumedAsPremise !== true
        && item.vacuous !== true && item.conclusion !== 'True'
        && !(item.axioms || []).some((axiom) => !allowed.has(axiom))
        && (item.verifiedObligations || []).includes(mapping.obligationId));
      if (!covered) issues.push('target_theorem_obligation_coverage_incomplete');
    }
    const contractVerification = verifyFormalClaimContract(claim.formalClaimContract, {
      claimId: claim.claimId,
      manuscriptClaimHash: claim.manuscriptClaimHash,
      theoremName: claim.theoremName,
      theoremTypeHash: claim.expectedTypeHash,
      sourceStatementHash: claim.sourceStatementHash,
      proofObligations,
      proofObligationContracts: obligationMapping.contracts,
      proofObligationMappings: obligationMapping.mappings,
    });
    issues.push(...contractVerification.blockers);
    blockers.push(...issues.map((issue) => `${claim.claimId || claim.theoremName || 'unknown'}:${issue}`));
    return Object.freeze({
      claimId: claim.claimId || null,
      manuscriptClaimHash: claim.manuscriptClaimHash || null,
      formalClaimContractHash: contractVerification.formalClaimContractHash,
      theoremName: claim.theoremName || null,
      declarationTypeHash: declaration?.typeHash || null,
      sourceStatementHash: declaration?.sourceStatementHash || null,
      axioms: declaration?.axioms || [],
      expectedObligations: [...proofObligations].sort(),
      proofObligationContracts: obligationMapping.contracts,
      proofObligationMappings: obligationMapping.mappings,
      verifiedObligations,
      valid: issues.length === 0,
      issues,
    });
  });
  if (!claims.length) blockers.push('formal_claim_bindings_missing');
  const payload = {
    version: 1,
    kind: 'FormalClaimBindingReport',
    status: blockers.length ? 'formal_claim_binding_blocked' : 'formal_claim_binding_verified',
    bindings,
    allowedAxioms: [...allowed].sort(),
    blockers,
  };
  return Object.freeze({ ...payload, formalClaimBindingHash: hashRecord('FormalClaimBindingReport', payload) });
}
