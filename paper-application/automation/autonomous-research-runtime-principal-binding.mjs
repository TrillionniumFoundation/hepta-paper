import {
  buildAutonomousResearchRuntimePrincipalBinding,
} from '../../paper-domain/automation/autonomous-research-runtime-principal-binding-contract.mjs';
import {
  verifyAutonomousResearchAgentProductionAuthorityBinding,
} from '../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs';

export function composeAutonomousResearchRuntimePrincipalBinding({
  required = false,
  authorIdentityConfigurationHash = null,
  authorPrincipal = null,
  researchPrincipalPool = null,
  externalCapabilityTrustInspection = null,
} = {}) {
  const reviewerTrust = externalCapabilityTrustInspection?.components?.reviewerPool || null;
  try {
    return buildAutonomousResearchRuntimePrincipalBinding({
      authorPrincipalId: authorPrincipal?.principalId,
      authorIdentityConfigurationHash,
      authorIdentitySubjectHash: authorPrincipal?.identityAttestationSubjectHash,
      authorCapabilityReceiptHash:
        authorPrincipal?.capabilityReceipt?.codexResearchAuthorCapabilityReceiptHash,
      authorCredentialRootIdentityHash:
        authorPrincipal?.capabilityReceipt?.credentialRootIdentityHash,
      researchPrincipalPoolHash: researchPrincipalPool?.researchPrincipalPoolHash,
      reviewerTrustSetHash: reviewerTrust?.trustSetHash,
      reviewerSignatureVerificationPolicyHash:
        reviewerTrust?.signatureVerificationPolicyHash,
    });
  } catch {
    if (required) {
      throw new Error('autonomous_research_runtime_principal_binding_required');
    }
    return null;
  }
}

export function requireAutonomousResearchAgentProductionAuthorityBinding({
  required = false,
  binding = null,
  runtimePrincipalBinding = null,
  autonomousResearchProviderConfigurationHash = null,
} = {}) {
  if (binding === null || binding === undefined) {
    if (required) {
      throw new Error('autonomous_research_agent_production_authority_binding_required');
    }
    return null;
  }
  if (!verifyAutonomousResearchAgentProductionAuthorityBinding(binding)
    || binding.runtimePrincipalBindingHash
      !== runtimePrincipalBinding?.runtimePrincipalBindingHash
    || JSON.stringify(binding.runtimePrincipalBinding)
      !== JSON.stringify(runtimePrincipalBinding)
    || binding.autonomousResearchProviderConfigurationHash
      !== autonomousResearchProviderConfigurationHash) {
    throw new Error('autonomous_research_agent_production_authority_binding_invalid');
  }
  return binding;
}
