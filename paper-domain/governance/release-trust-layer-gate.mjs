import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function boundedCount(value, required, label) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > required) throw new Error(`release_trust_gate_${label}_count_invalid`);
  return count;
}

export function buildReleaseTrustLayerGate({
  releaseCommit,
  capabilityCount,
  implementationVerified,
  releaseBoundConformanceVerified,
  independentProductionOperationalVerified,
} = {}) {
  const required = Number(capabilityCount);
  if (!String(releaseCommit || '').trim()) throw new Error('release_trust_gate_release_commit_required');
  if (!Number.isInteger(required) || required <= 0) throw new Error('release_trust_gate_capability_count_invalid');
  const implementation = boundedCount(implementationVerified, required, 'implementation');
  const conformance = boundedCount(releaseBoundConformanceVerified, required, 'conformance');
  const operational = boundedCount(independentProductionOperationalVerified, required, 'operational');
  const payload = {
    version: 1,
    kind: 'ReleaseTrustLayerGate',
    status: implementation === required && conformance === required
      ? 'code_release_trust_layers_ready'
      : 'code_release_trust_layers_blocked',
    releaseCommit,
    capabilityCount: required,
    implementation: { verified: implementation, required, releaseBlocking: true },
    releaseBoundConformance: { verified: conformance, required, releaseBlocking: true, productionEligible: false },
    independentProductionOperational: { verified: operational, required, releaseBlocking: false, externalIndependentRequired: true },
    conformanceCannotQualifyAsOperationalProof: true,
    operationalProofCannotSubstituteForReleaseBoundConformance: true,
  };
  return Object.freeze({ ...payload, releaseTrustLayerGateHash: hashRecord('ReleaseTrustLayerGate', payload) });
}
