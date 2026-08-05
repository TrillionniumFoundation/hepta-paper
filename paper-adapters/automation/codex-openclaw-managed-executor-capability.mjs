import {
  openClawManagedFailureExecutorBinding,
} from './codex-openclaw-managed-failure-execution-binding.mjs';
import {
  buildManagedWorkspaceSnapshot,
} from './codex-openclaw-managed-workspace-repository.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function managedAuthBindingMode(value) {
  if (value?.openClawManagedAuthBindingMode) {
    return value.openClawManagedAuthBindingMode;
  }
  return SHA256.test(String(value?.openClawManagedAuthProfileIdentityHash || ''))
    && !value?.openClawManagedGatewayRouteIdentityHash
    ? 'user-locked-profile' : null;
}

function managedAuthBindingValid(value) {
  const mode = managedAuthBindingMode(value);
  const profile = value?.openClawManagedAuthProfileIdentityHash ?? null;
  const route = value?.openClawManagedGatewayRouteIdentityHash ?? null;
  return mode === 'user-locked-profile'
    ? SHA256.test(String(profile || '')) && route === null
    : mode === 'current-agent-gateway-oauth-route'
      && profile === null && SHA256.test(String(route || ''));
}

export function openClawManagedRuntimeExpected(capabilityReceipt) {
  return /^codex-openclaw-managed\s+3\b/.test(
    String(capabilityReceipt?.codexVersion || ''),
  );
}

export function openClawManagedCapabilityIdentityMatches(runtime, capability) {
  return runtime?.managedRuntimeEvidenceRequired
      === (capability?.managedRuntimeEvidenceRequired === true)
    && runtime?.openClawManagedConfigurationHash
      === (capability?.openClawManagedConfigurationHash || null)
    && runtime?.openClawManagedRuntimeProvenanceHash
      === (capability?.openClawManagedRuntimeProvenanceHash || null)
    && runtime?.openClawManagedAuthProfileIdentityHash
      === (capability?.openClawManagedAuthProfileIdentityHash || null)
    && runtime?.openClawManagedGatewayRouteIdentityHash
      === (capability?.openClawManagedGatewayRouteIdentityHash || null)
    && managedAuthBindingMode(runtime) === managedAuthBindingMode(capability)
    && runtime?.openClawManagedAuthSourceIdentityHash
      === (capability?.openClawManagedAuthSourceIdentityHash || null)
    && runtime?.openClawManagedAgentId
      === (capability?.openClawManagedAgentId || null)
    && runtime?.openClawManagedPrincipalRole
      === (capability?.openClawManagedPrincipalRole || null)
    && runtime?.openClawManagedMaximumContextBytes
      === (capability?.openClawManagedMaximumContextBytes ?? null)
    && runtime?.openClawManagedMaximumFileCount
      === (capability?.openClawManagedMaximumFileCount ?? null);
}

export function managedCapabilityReceiptValid(
  receipt,
  expectedPrincipalRole,
) {
  if (!openClawManagedRuntimeExpected(receipt)) return true;
  const mode = managedAuthBindingMode(receipt);
  const transportValid = mode === 'user-locked-profile'
    ? receipt.executionTransport === 'openclaw_user_locked_codex_app_server'
      && receipt.authenticationAuthorityMode
        === 'openclaw_user_locked_profile_fail_closed'
    : mode === 'current-agent-gateway-oauth-route'
      && receipt.executionTransport === 'openclaw_gateway_direct_rpc'
      && receipt.authenticationAuthorityMode
        === 'openclaw_current_agent_gateway_oauth';
  return transportValid
    && managedAuthBindingValid(receipt)
    && receipt.managedRuntimeEvidenceRequired === true
    && [
      receipt.openClawManagedConfigurationHash,
      receipt.openClawManagedRuntimeProvenanceHash,
      receipt.openClawManagedAuthSourceIdentityHash,
    ].every((value) => SHA256.test(String(value || '')))
    && SAFE_AGENT_ID.test(String(receipt.openClawManagedAgentId || ''))
    && receipt.openClawManagedPrincipalRole === expectedPrincipalRole
    && Number.isInteger(receipt.openClawManagedMaximumContextBytes)
    && receipt.openClawManagedMaximumContextBytes >= 4096
    && receipt.openClawManagedMaximumContextBytes <= 4 * 1024 * 1024
    && Number.isInteger(receipt.openClawManagedMaximumFileCount)
    && receipt.openClawManagedMaximumFileCount >= 1
    && receipt.openClawManagedMaximumFileCount <= 256;
}

export function managedFailureExecutorBindingForWorkspace({
  capabilityReceipt,
  executionInvocationId,
  executionRole,
  originalPromptHash,
  principalId,
  principalRole,
  sandbox,
  workspace,
} = {}) {
  const sourceSnapshot = buildManagedWorkspaceSnapshot({
    workspace,
    maximumContextBytes:
      capabilityReceipt?.openClawManagedMaximumContextBytes,
    maximumFileCount:
      capabilityReceipt?.openClawManagedMaximumFileCount,
  });
  return openClawManagedFailureExecutorBinding({
    capabilityReceipt,
    agentId: capabilityReceipt?.openClawManagedAgentId,
    executionInvocationId,
    executionRole,
    principalId,
    principalRole,
    originalPromptHash,
    sandbox,
    workspace,
    sourceSnapshot,
  });
}
