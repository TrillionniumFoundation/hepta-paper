import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const USER_LOCKED_PROFILE_AUTH_BINDING_MODE = 'user-locked-profile';
const CURRENT_AGENT_GATEWAY_AUTH_BINDING_MODE =
  'current-agent-gateway-oauth-route';
const VERSION_ONE_KEYS = Object.freeze([
  'formalReviewerCapabilityReceiptHash',
  'formalReviewerCredentialConfigIdentityHash',
  'formalReviewerOpenClawManagedAuthProfileIdentityHash',
  'kind',
  'openClawManagedAuthSourceIdentityHash',
  'openClawManagedRuntimeProvenanceHash',
  'providerConfigurationHash',
  'researchAuthorCapabilityReceiptHash',
  'researchAuthorCredentialConfigIdentityHash',
  'researchAuthorOpenClawManagedAuthProfileIdentityHash',
  'version',
].sort());
const VERSION_TWO_KEYS = Object.freeze([
  ...VERSION_ONE_KEYS,
  'openClawManagedAuthBindingMode',
  'openClawManagedGatewayRouteIdentityHash',
].sort());
const VERSION_TWO_COMMON_HASH_KEYS = Object.freeze([
  'formalReviewerCapabilityReceiptHash',
  'formalReviewerCredentialConfigIdentityHash',
  'openClawManagedAuthSourceIdentityHash',
  'openClawManagedRuntimeProvenanceHash',
  'providerConfigurationHash',
  'researchAuthorCapabilityReceiptHash',
  'researchAuthorCredentialConfigIdentityHash',
]);

export function autonomousResearchOneShotProviderRuntimeBindingHash(value) {
  return hashRecord('AutonomousResearchOneShotProviderRuntimeBinding', value);
}

export function verifyAutonomousResearchOneShotProviderRuntimeBinding(value) {
  if (value?.version === 1) {
    return exactKeys(value, VERSION_ONE_KEYS)
      && value.kind === 'AutonomousResearchOneShotProviderRuntimeBinding'
      && Object.entries(value).filter(([key]) => !['version', 'kind'].includes(key))
        .every(([, candidate]) => SHA256.test(String(candidate || '')));
  }
  if (!exactKeys(value, VERSION_TWO_KEYS)
    || value.version !== 2
    || value.kind !== 'AutonomousResearchOneShotProviderRuntimeBinding'
    || !VERSION_TWO_COMMON_HASH_KEYS.every((key) => (
      SHA256.test(String(value[key] || ''))
    ))) {
    return false;
  }
  if (value.openClawManagedAuthBindingMode === USER_LOCKED_PROFILE_AUTH_BINDING_MODE) {
    return SHA256.test(String(
      value.researchAuthorOpenClawManagedAuthProfileIdentityHash || '',
    ))
      && SHA256.test(String(
        value.formalReviewerOpenClawManagedAuthProfileIdentityHash || '',
      ))
      && value.openClawManagedGatewayRouteIdentityHash === null;
  }
  return value.openClawManagedAuthBindingMode
      === CURRENT_AGENT_GATEWAY_AUTH_BINDING_MODE
    && value.researchAuthorOpenClawManagedAuthProfileIdentityHash === null
    && value.formalReviewerOpenClawManagedAuthProfileIdentityHash === null
    && SHA256.test(String(value.openClawManagedGatewayRouteIdentityHash || ''));
}
