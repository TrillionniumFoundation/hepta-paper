export const EXTERNAL_QUALIFICATION_FAILURE_CODES = Object.freeze({
  RECEIPT_SHAPE_INVALID: 'external_qualification.receipt_shape_invalid',
  RECEIPT_HASH_INVALID: 'external_qualification.receipt_hash_invalid',
  RECEIPT_SIGNATURE_INVALID: 'external_qualification.receipt_signature_invalid',
  RELEASE_POINTER_MISMATCH: 'external_qualification.release_pointer_mismatch',
  PREPARATION_BINDING_MISMATCH: 'external_qualification.preparation_binding_mismatch',
  INDEPENDENT_VERIFIER_ATTESTATION_INVALID:
    'external_qualification.independent_verifier_attestation_invalid',
  INDEPENDENT_VERIFICATION_BINDING_INVALID:
    'external_qualification.independent_verification_binding_invalid',
  FULL_DOMAIN_CRYPTOGRAPHIC_INTEGRITY_INVALID:
    'external_qualification.full_domain_cryptographic_integrity_invalid',
  VERIFICATION_TIME_INVALID: 'external_qualification.verification_time_invalid',
  RECEIPT_TIME_WINDOW_INVALID: 'external_qualification.receipt_time_window_invalid',
  INDEPENDENT_VERIFIER_UNAVAILABLE: 'external_qualification.independent_verifier_unavailable',
  PRIOR_ART_QUALIFICATION_INVALID: 'external_qualification.prior_art_qualification_invalid',
  RUNTIME_REPRODUCIBILITY_BINDING_INVALID:
    'external_qualification.runtime_reproducibility_binding_invalid',
  RELEASE_SCOPE_NOT_ELIGIBLE:
    'external_qualification.release_scope_not_eligible',
  MANUSCRIPT_RELEASE_PROOF_MISMATCH:
    'external_qualification.manuscript_release_proof_mismatch',
  INDEPENDENT_VERIFICATION_POLICY_INVALID:
    'external_qualification.independent_verification_policy_invalid',
  FULL_VERIFICATION_CONTEXT_UNAVAILABLE:
    'external_qualification.full_verification_context_unavailable',
  FULL_VERIFICATION_CONTEXT_CONFIGURATION_MISSING:
    'external_qualification.full_verification_context_configuration_missing',
  FULL_DOMAIN_NOT_READY: 'external_qualification.full_domain_not_ready',
  FAILURE_CLASSIFICATION_INVALID: 'external_qualification.failure_classification_invalid',
});

const TERMINAL_FOR_CONFIGURATION = new Set([
  EXTERNAL_QUALIFICATION_FAILURE_CODES.RECEIPT_SHAPE_INVALID,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.RECEIPT_HASH_INVALID,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.RECEIPT_SIGNATURE_INVALID,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.RELEASE_POINTER_MISMATCH,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.PREPARATION_BINDING_MISMATCH,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.INDEPENDENT_VERIFIER_ATTESTATION_INVALID,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.INDEPENDENT_VERIFICATION_BINDING_INVALID,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.FULL_DOMAIN_CRYPTOGRAPHIC_INTEGRITY_INVALID,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.RUNTIME_REPRODUCIBILITY_BINDING_INVALID,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.RELEASE_SCOPE_NOT_ELIGIBLE,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.MANUSCRIPT_RELEASE_PROOF_MISMATCH,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.INDEPENDENT_VERIFICATION_POLICY_INVALID,
  EXTERNAL_QUALIFICATION_FAILURE_CODES.FULL_VERIFICATION_CONTEXT_CONFIGURATION_MISSING,
]);
const KNOWN_CODES = new Set(Object.values(EXTERNAL_QUALIFICATION_FAILURE_CODES));

export function classifyExternalQualificationFailureCodes(failureCodes) {
  const supplied = Array.isArray(failureCodes) ? failureCodes : [];
  const codes = [...new Set(supplied.map(String).filter(Boolean))];
  const valid = codes.length > 0 && codes.length === supplied.length
    && codes.every((code) => KNOWN_CODES.has(code)
      && code !== EXTERNAL_QUALIFICATION_FAILURE_CODES.FAILURE_CLASSIFICATION_INVALID);
  const effectiveCodes = valid
    ? codes : [EXTERNAL_QUALIFICATION_FAILURE_CODES.FAILURE_CLASSIFICATION_INVALID];
  return Object.freeze({
    valid,
    terminalForConfiguration: !valid
      || effectiveCodes.some((code) => TERMINAL_FOR_CONFIGURATION.has(code)),
    failureCodes: Object.freeze(effectiveCodes),
  });
}
