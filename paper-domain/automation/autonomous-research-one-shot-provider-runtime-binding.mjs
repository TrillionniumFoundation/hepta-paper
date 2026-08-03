import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function autonomousResearchOneShotProviderRuntimeBindingHash(value) {
  return hashRecord('AutonomousResearchOneShotProviderRuntimeBinding', value);
}

export function verifyAutonomousResearchOneShotProviderRuntimeBinding(value) {
  return exactKeys(value, [
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
  ].sort())
    && value.version === 1
    && value.kind === 'AutonomousResearchOneShotProviderRuntimeBinding'
    && Object.entries(value).filter(([key]) => !['version', 'kind'].includes(key))
      .every(([, candidate]) => SHA256.test(String(candidate || '')));
}
