import {
  loadCapabilityConformanceProofs,
  loadCapabilityOperationalProofs,
} from '../../paper-adapters/governance/capability-proof-verifier.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const GPU_SCIENTIFIC_CAPABILITY_IDS = Object.freeze({
  pde: 'research.gpu-pde-solver',
  deepLearning: 'research.gpu-deep-learning-training',
});

function capabilityProofEntry(capabilityId, operational, conformance) {
  const operationalProof = operational.get(capabilityId) || null;
  const productionQualification = conformance.get(capabilityId) || null;
  return Object.freeze({
    capabilityId,
    operationalProofReady: Boolean(operationalProof),
    operationalReceiptHashes: Object.freeze(
      [...(operationalProof?.operationalReceiptHashes || [])].sort(),
    ),
    productionQualificationReady: Boolean(productionQualification),
    conformanceReceiptHashes: Object.freeze(
      [...(productionQualification?.conformanceReceiptHashes || [])].sort(),
    ),
    conformanceIssuerAssurances: Object.freeze(
      [...(productionQualification?.issuerAssurances || [])].sort(),
    ),
  });
}

export function inspectGpuScientificCapabilityProofs({
  runtimeRoot,
  workspaceRoot,
  releaseCommit,
  codeProvenance,
} = {}) {
  const operational = loadCapabilityOperationalProofs({
    runtimeRoot,
    workspaceRoot,
    capabilityCatalog: CAPABILITY_CATALOG,
    releaseCommit,
  });
  const conformance = loadCapabilityConformanceProofs({
    runtimeRoot,
    workspaceRoot,
    capabilityCatalog: CAPABILITY_CATALOG,
    releaseCommit,
    codeProvenance,
  });
  const capabilities = Object.freeze(Object.fromEntries(
    Object.entries(GPU_SCIENTIFIC_CAPABILITY_IDS).map(([name, capabilityId]) => [
      name,
      capabilityProofEntry(capabilityId, operational, conformance),
    ]),
  ));
  const payload = {
    version: 1,
    kind: 'GpuScientificCapabilityProofInspection',
    status: Object.values(capabilities).every((entry) => (
      entry.operationalProofReady && entry.productionQualificationReady
    )) ? 'gpu_scientific_capability_proofs_ready'
      : 'gpu_scientific_capability_proofs_blocked',
    releaseCommit,
    capabilities,
    externalIndependentOperationalProofRequired: true,
    releaseBoundConformanceRequired: true,
  };
  return Object.freeze({
    ...payload,
    gpuScientificCapabilityProofInspectionHash:
      hashRecord('GpuScientificCapabilityProofInspection', payload),
  });
}

export { GPU_SCIENTIFIC_CAPABILITY_IDS };
