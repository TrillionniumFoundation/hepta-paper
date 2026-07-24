import {
  buildAutonomousResearchAgentProductionAuthorityBinding,
  verifyAutonomousResearchAgentProductionAuthorityBinding,
} from '../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs';
import {
  buildAutonomousResearchRuntimePrincipalBinding,
  verifyAutonomousResearchRuntimePrincipalBinding,
} from '../../paper-domain/automation/autonomous-research-runtime-principal-binding-contract.mjs';

function claimed(value) {
  return value !== null && value !== undefined;
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validatePreparationRuntimeBinding(preparation) {
  const bindingClaimed = claimed(preparation?.runtimePrincipalBinding);
  const hashClaimed = claimed(preparation?.runtimePrincipalBindingHash);
  if (!bindingClaimed && !hashClaimed) return null;
  if (!bindingClaimed || !hashClaimed
    || !verifyAutonomousResearchRuntimePrincipalBinding(
      preparation.runtimePrincipalBinding,
    ) || preparation.runtimePrincipalBindingHash
      !== preparation.runtimePrincipalBinding.runtimePrincipalBindingHash) {
    throw new Error('autonomous_research_runtime_principal_binding_invalid');
  }
  return preparation.runtimePrincipalBinding;
}

function validatePreparationProductionBinding(preparation, runtimeBinding) {
  const bindingClaimed = claimed(preparation?.productionAuthorityBinding);
  const hashClaimed = claimed(preparation?.productionAuthorityBindingHash);
  if (!bindingClaimed && !hashClaimed) return null;
  const binding = preparation.productionAuthorityBinding;
  if (!bindingClaimed || !hashClaimed
    || !verifyAutonomousResearchAgentProductionAuthorityBinding(binding)
    || preparation.productionAuthorityBindingHash
      !== binding.autonomousResearchAgentProductionAuthorityBindingHash
    || !runtimeBinding
    || binding.runtimePrincipalBindingHash
      !== runtimeBinding.runtimePrincipalBindingHash
    || !sameRecord(binding.runtimePrincipalBinding, runtimeBinding)
    || binding.autonomousResearchProviderConfigurationHash
      !== preparation.autonomousResearchProviderConfigurationHash) {
    throw new Error('autonomous_research_agent_production_authority_binding_invalid');
  }
  return binding;
}

function oneBinding(bindings, hashField, mismatchCode) {
  const unique = [...new Map(bindings.filter(Boolean).map((binding) => [
    binding[hashField],
    binding,
  ])).values()];
  if (unique.length > 1) throw new Error(mismatchCode);
  return unique[0] || null;
}

export function inspectCampaignPreparationPrincipalAuthorityBindings(preparations = []) {
  const runtimeBindings = [];
  const productionBindings = [];
  for (const preparation of preparations) {
    const runtimeBinding = validatePreparationRuntimeBinding(preparation);
    const productionBinding = validatePreparationProductionBinding(
      preparation,
      runtimeBinding,
    );
    if (preparation?.launchMode === 'production-run' && !runtimeBinding) {
      throw new Error('autonomous_research_runtime_principal_binding_required');
    }
    if (preparation?.launchMode === 'production-run' && !productionBinding) {
      throw new Error('autonomous_research_agent_production_authority_binding_required');
    }
    runtimeBindings.push(runtimeBinding);
    productionBindings.push(productionBinding);
  }
  const runtimePrincipalBinding = oneBinding(
    runtimeBindings,
    'runtimePrincipalBindingHash',
    'autonomous_research_runtime_principal_binding_mismatch',
  );
  const productionAuthorityBinding = oneBinding(
    productionBindings,
    'autonomousResearchAgentProductionAuthorityBindingHash',
    'autonomous_research_agent_production_authority_binding_mismatch',
  );
  return Object.freeze({ runtimePrincipalBinding, productionAuthorityBinding });
}

export function requireCurrentCampaignWorkerPrincipalAuthority({
  expectedRuntimePrincipalBinding = null,
  expectedProductionAuthorityBinding = null,
  providerConfiguration = null,
  researchAuthorPreflight = null,
  authorIdentityAttestation = null,
  researchPrincipalPoolHash = null,
  reviewerTrustSetHash = null,
  reviewerSignatureVerificationPolicyHash = null,
} = {}) {
  if (!expectedRuntimePrincipalBinding && !expectedProductionAuthorityBinding) return null;
  let runtimePrincipalBinding = null;
  try {
    runtimePrincipalBinding = buildAutonomousResearchRuntimePrincipalBinding({
      authorPrincipalId: researchAuthorPreflight?.effectivePrincipalId,
      authorIdentityConfigurationHash: authorIdentityAttestation?.configurationHash,
      authorIdentitySubjectHash: authorIdentityAttestation?.subject
        ?.externalPrincipalIdentityAttestationSubjectHash,
      authorCapabilityReceiptHash: researchAuthorPreflight?.capabilityReceipt
        ?.codexResearchAuthorCapabilityReceiptHash,
      authorCredentialRootIdentityHash: researchAuthorPreflight?.capabilityReceipt
        ?.credentialRootIdentityHash,
      researchPrincipalPoolHash,
      reviewerTrustSetHash,
      reviewerSignatureVerificationPolicyHash,
    });
  } catch { /* rejected by the exact comparison below */ }
  if (!sameRecord(runtimePrincipalBinding, expectedRuntimePrincipalBinding)) {
    throw new Error('autonomous_research_runtime_principal_binding_invalid');
  }
  if (!expectedProductionAuthorityBinding) return runtimePrincipalBinding;
  let productionAuthorityBinding = null;
  try {
    productionAuthorityBinding = buildAutonomousResearchAgentProductionAuthorityBinding({
      runtimePrincipalBinding,
      autonomousResearchProviderConfigurationHash:
        providerConfiguration?.autonomousResearchProviderConfigurationHash,
      authorPrincipalId: researchAuthorPreflight?.effectivePrincipalId,
      authorProvider: researchAuthorPreflight?.capabilityReceipt?.provider,
      authorModel: researchAuthorPreflight?.capabilityReceipt?.model,
      authorCapabilityReceiptHash: researchAuthorPreflight?.capabilityReceipt
        ?.codexResearchAuthorCapabilityReceiptHash,
      authorCredentialRootIdentityHash: researchAuthorPreflight?.capabilityReceipt
        ?.credentialRootIdentityHash,
      authorCredentialConfigIdentityHash: researchAuthorPreflight?.capabilityReceipt
        ?.credentialConfigIdentityHash,
    });
  } catch { /* rejected by the exact comparison below */ }
  if (!sameRecord(productionAuthorityBinding, expectedProductionAuthorityBinding)) {
    throw new Error('autonomous_research_agent_production_authority_binding_invalid');
  }
  return productionAuthorityBinding;
}
