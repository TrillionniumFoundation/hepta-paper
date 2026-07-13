import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { PAPER_QUALITY_PROFILES } from './paper-quality-policy.mjs';

const WAIVABLE = Object.freeze({
  theorem_or_proof: Object.freeze(['limitations']),
  formal_theorem_or_proof: Object.freeze(['limitations']),
  empirical_or_experiment: Object.freeze(['limitations']),
  systems_or_artifact: Object.freeze(['limitations']),
  survey_or_position: Object.freeze(['limitations']),
  external_data_or_human_subjects: Object.freeze([]),
});

export function buildPaperProfileEvidenceContract({ paperTask, profile, claimRegistry = null } = {}) {
  const requirements = PAPER_QUALITY_PROFILES[profile] || null;
  const formalClaimPresent = (claimRegistry?.claims || []).some((claim) => /(?:formal|proof|theorem)/i.test(String(claim?.verificationPlan?.kind || claim?.claimKind || claim?.riskClass || '')));
  const effectiveRequirements = [...(requirements || [])];
  if (formalClaimPresent && !effectiveRequirements.includes('formal_claim_binding')) effectiveRequirements.push('formal_claim_binding');
  const blockers = [
    ...(!paperTask?.paperId ? ['paper_profile_contract_paper_required'] : []),
    ...(!requirements ? ['paper_profile_contract_profile_invalid'] : []),
  ];
  const payload = {
    version: 1,
    kind: 'PaperProfileEvidenceContract',
    paperId: paperTask?.paperId || null,
    taskHash: paperTask?.taskHash || null,
    profile: profile || null,
    requirements: effectiveRequirements,
    waivableRequirements: [...(WAIVABLE[profile] || [])],
    formalVerificationRequired: effectiveRequirements.includes('formal_claim_binding'),
    status: blockers.length ? 'paper_profile_evidence_contract_blocked' : 'paper_profile_evidence_contract_verified',
    blockers,
  };
  return Object.freeze({ ...payload, paperProfileEvidenceContractHash: hashRecord('PaperProfileEvidenceContract', payload) });
}
