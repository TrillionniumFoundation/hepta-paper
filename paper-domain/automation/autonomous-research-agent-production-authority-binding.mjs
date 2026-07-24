import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchRuntimePrincipalBinding,
} from './autonomous-research-runtime-principal-binding-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const KEYS = Object.freeze([
  'authorCapabilityReceiptHash', 'authorCredentialConfigIdentityHash',
  'authorCredentialRootIdentityHash', 'authorModel', 'authorPrincipalId',
  'authorProvider', 'autonomousResearchAgentProductionAuthorityBindingHash',
  'autonomousResearchProviderConfigurationHash', 'kind', 'runtimePrincipalBinding',
  'runtimePrincipalBindingHash', 'version',
]);

function canonicalHash(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function canonicalText(value, maximum = 512) {
  const candidate = String(value || '').normalize('NFKC').trim();
  return candidate && candidate.length <= maximum ? candidate : null;
}

export function buildAutonomousResearchAgentProductionAuthorityBinding({
  runtimePrincipalBinding,
  autonomousResearchProviderConfigurationHash,
  authorPrincipalId,
  authorProvider,
  authorModel,
  authorCapabilityReceiptHash,
  authorCredentialRootIdentityHash,
  authorCredentialConfigIdentityHash,
} = {}) {
  const principalId = String(authorPrincipalId || '').trim();
  const provider = canonicalText(authorProvider, 160);
  const model = canonicalText(authorModel, 512);
  const providerConfigurationHash = canonicalHash(
    autonomousResearchProviderConfigurationHash,
  );
  const capabilityReceiptHash = canonicalHash(authorCapabilityReceiptHash);
  const credentialRootIdentityHash = canonicalHash(authorCredentialRootIdentityHash);
  const credentialConfigIdentityHash = canonicalHash(authorCredentialConfigIdentityHash);
  if (!verifyAutonomousResearchRuntimePrincipalBinding(runtimePrincipalBinding)
    || !SAFE_ID.test(principalId) || !provider || !model
    || !providerConfigurationHash || !capabilityReceiptHash
    || !credentialRootIdentityHash || !credentialConfigIdentityHash
    || runtimePrincipalBinding.authorPrincipalId !== principalId
    || runtimePrincipalBinding.authorCapabilityReceiptHash !== capabilityReceiptHash
    || runtimePrincipalBinding.authorCredentialRootIdentityHash
      !== credentialRootIdentityHash) {
    throw new Error('autonomous_research_agent_production_authority_binding_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousResearchAgentProductionAuthorityBinding',
    runtimePrincipalBinding,
    runtimePrincipalBindingHash: runtimePrincipalBinding.runtimePrincipalBindingHash,
    autonomousResearchProviderConfigurationHash: providerConfigurationHash,
    authorPrincipalId: principalId,
    authorProvider: provider,
    authorModel: model,
    authorCapabilityReceiptHash: capabilityReceiptHash,
    authorCredentialRootIdentityHash: credentialRootIdentityHash,
    authorCredentialConfigIdentityHash: credentialConfigIdentityHash,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchAgentProductionAuthorityBindingHash: hashRecord(
      'AutonomousResearchAgentProductionAuthorityBinding',
      payload,
    ),
  });
}

export function verifyAutonomousResearchAgentProductionAuthorityBinding(binding) {
  if (!hasExactObjectKeys(binding, KEYS)) return false;
  try {
    return JSON.stringify(buildAutonomousResearchAgentProductionAuthorityBinding(binding))
      === JSON.stringify(binding);
  } catch { return false; }
}

export function verifyAgentExecutionReceiptProductionAuthorityBinding(
  agentExecutionReceipt,
  binding,
) {
  if (!verifyAutonomousResearchAgentProductionAuthorityBinding(binding)) return false;
  return agentExecutionReceipt?.agentId === binding.authorPrincipalId
    && agentExecutionReceipt?.providerMode === binding.authorProvider
    && (agentExecutionReceipt?.resolvedModel || agentExecutionReceipt?.model || null)
      === binding.authorModel
    && agentExecutionReceipt?.codexResearchAuthorCapabilityReceiptHash
      === binding.authorCapabilityReceiptHash
    && agentExecutionReceipt?.codexCredentialRootIdentityHash
      === binding.authorCredentialRootIdentityHash
    && agentExecutionReceipt?.codexCredentialConfigIdentityHash
      === binding.authorCredentialConfigIdentityHash;
}
