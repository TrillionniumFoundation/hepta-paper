import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function values(value) { return Array.isArray(value) ? value : []; }

export function evaluateClaimContractReadiness({ claimRegistry } = {}) {
  const claims = values(claimRegistry?.claims);
  const blockers = [];
  if (claimRegistry?.status !== 'claim_graph_valid') blockers.push('claim_registry_not_valid');
  if (!claims.length) blockers.push('claim_registry_empty');
  const claimResults = claims.map((claim) => {
    const issues = [];
    if (!claim.claimId) issues.push('claim_id_missing');
    if (!String(claim.text || '').trim()) issues.push('claim_text_missing');
    if (!String(claim.sourceLocator || '').trim()) issues.push('claim_source_locator_missing');
    if (!claim.verificationPlan) issues.push('claim_verification_plan_missing');
    if (claim.claimKind === 'worker_bound_claim') issues.push('worker_synthesized_claim_forbidden');
    if (/(?:theorem|proof|formal)/i.test(String(claim.claimKind || claim.riskClass || ''))
      && !values(claim.proofObligations).length) issues.push('claim_proof_obligations_missing');
    blockers.push(...issues.map((issue) => `${claim.claimId || 'unknown'}:${issue}`));
    return { claimId: claim.claimId || null, valid: issues.length === 0, issues };
  });
  const payload = {
    version: 1,
    kind: 'ClaimContractReadinessPolicy',
    status: blockers.length ? 'claim_contract_readiness_blocked' : 'claim_contract_readiness_ready',
    claimRegistryHash: claimRegistry?.claimRegistryHash || null,
    claimCount: claims.length,
    claimResults,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, claimContractReadinessPolicyHash: hashRecord('ClaimContractReadinessPolicy', payload) });
}
