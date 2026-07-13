import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const PAPER_QUALITY_PROFILES = Object.freeze({
  theorem_or_proof: Object.freeze(['claim_registry', 'proof_review', 'limitations']),
  formal_theorem_or_proof: Object.freeze(['claim_registry', 'formal_claim_binding', 'proof_review', 'limitations']),
  empirical_or_experiment: Object.freeze(['claim_registry', 'experiment_registry', 'dataset_provenance', 'reproduction_receipt', 'limitations']),
  systems_or_artifact: Object.freeze(['claim_registry', 'artifact_manifest', 'build_receipt', 'reproduction_receipt', 'limitations']),
  survey_or_position: Object.freeze(['claim_registry', 'source_provenance', 'novelty_scope_review', 'limitations']),
  external_data_or_human_subjects: Object.freeze(['claim_registry', 'dataset_provenance', 'data_rights', 'ethics_review', 'privacy_review', 'limitations']),
});

function normalizedEvidence(evidence = []) {
  return new Map((Array.isArray(evidence) ? evidence : []).filter((item) => item && typeof item === 'object').map((item) => [item.requirementId || item.kind, item]));
}

export function evaluatePaperQualityPolicy({ paperId = null, profile, evidence = [], shadow = true, requirementsOverride = null, waivableRequirements = [] } = {}) {
  const requirements = requirementsOverride || PAPER_QUALITY_PROFILES[profile] || null;
  const blockers = [];
  if (!paperId) blockers.push('paper_id_missing');
  if (!requirements) blockers.push('paper_quality_profile_missing_or_invalid');
  const byRequirement = normalizedEvidence(evidence);
  const requirementResults = (requirements || []).map((requirementId) => {
    const item = byRequirement.get(requirementId) || null;
    const waiver = byRequirement.get(`${requirementId}_waiver`) || null;
    const waived = waivableRequirements.includes(requirementId) && Boolean(waiver && waiver.verified === true && waiver.hash && !waiver.blocked);
    const valid = waived || Boolean(item && item.verified === true && item.hash && !item.blocked);
    if (!valid) blockers.push(`paper_quality_evidence_missing_or_invalid:${requirementId}`);
    return Object.freeze({ requirementId, valid, waived, evidenceHash: waived ? waiver?.hash : item?.hash || null, evidenceKind: waived ? waiver?.kind : item?.kind || null });
  });
  const passed = blockers.length === 0;
  const payload = {
    version: 1,
    kind: 'PaperQualityPolicyReport',
    paperId,
    profile: profile || null,
    mode: shadow ? 'shadow' : 'enforced',
    status: passed ? 'paper_quality_policy_passed' : shadow ? 'paper_quality_policy_shadow_blocked' : 'paper_quality_policy_blocked',
    passed,
    requirements: requirementResults,
    blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, paperQualityPolicyHash: hashRecord('PaperQualityPolicyReport', payload) });
}
