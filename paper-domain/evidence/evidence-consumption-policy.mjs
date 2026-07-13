import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluateEvidenceReferenceValidity } from './evidence-reference-validity.mjs';
import { evaluateDependencyFreshness } from './dependency-freshness-policy.mjs';

function values(value) { return Array.isArray(value) ? value.map(String) : []; }

export function evaluateEvidenceConsumption({
  reference = {}, expected = {}, nowMs = Date.now(), maximumAgeMs = null,
  requiredOutputs = [], availableOutputs = [], claimId = null, sourceLocator = null,
  acceptedResultClasses = ['positive', 'verified'], resultClass = null,
  forbiddenSideEffects = [], observedSideEffects = [], requireCreatedAt = true,
  dependencyNodes = [],
} = {}) {
  const validity = evaluateEvidenceReferenceValidity({ reference, expected, nowMs, maximumAgeMs });
  const blockers = [...validity.blockers];
  const createdAt = reference?.createdAt || reference?.created_at || null;
  if (requireCreatedAt && !Number.isFinite(Date.parse(createdAt || ''))) blockers.push('evidence_created_at_missing_or_invalid');
  const outputs = new Set(values(availableOutputs));
  for (const required of values(requiredOutputs)) if (!outputs.has(required)) blockers.push(`evidence_required_output_missing:${required}`);
  if (claimId && !values(reference?.claimIds || reference?.claim_ids).includes(String(claimId))) blockers.push('evidence_claim_binding_mismatch');
  if (sourceLocator && String(reference?.sourceLocator || reference?.source_locator || reference?.path || '') !== String(sourceLocator)) blockers.push('evidence_source_locator_mismatch');
  if (resultClass && !values(acceptedResultClasses).includes(String(resultClass))) blockers.push(`evidence_result_not_promotable:${resultClass}`);
  const forbidden = new Set(values(forbiddenSideEffects));
  for (const effect of values(observedSideEffects)) if (forbidden.has(effect)) blockers.push(`evidence_forbidden_side_effect:${effect}`);
  const dependencyFreshness = dependencyNodes.length ? evaluateDependencyFreshness({ nodes: dependencyNodes }) : null;
  if (dependencyFreshness?.status !== 'evidence_dependency_chain_fresh') blockers.push(...(dependencyFreshness?.blockers || []));
  const payload = {
    version: 1,
    kind: 'EvidenceConsumptionPolicyReport',
    status: blockers.length ? 'evidence_consumption_blocked' : 'evidence_consumption_ready',
    referenceValidityHash: validity.evidenceReferenceValidityHash,
    evidenceHash: validity.evidenceHash,
    requiredOutputs: values(requiredOutputs).sort(),
    availableOutputs: [...outputs].sort(),
    claimId,
    sourceLocator,
    resultClass,
    forbiddenSideEffects: [...forbidden].sort(),
    dependencyFreshnessHash: dependencyFreshness?.evidenceDependencyFreshnessHash || null,
    blockers: [...new Set(blockers)],
    warnings: validity.warnings,
  };
  return Object.freeze({ ...payload, evidenceConsumptionPolicyHash: hashRecord('EvidenceConsumptionPolicyReport', payload) });
}
