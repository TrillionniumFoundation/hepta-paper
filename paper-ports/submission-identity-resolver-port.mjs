export function assertSubmissionIdentityResolverPort(value) {
  if (value?.kind !== 'SubmissionIdentityResolverPort'
    || value.credentialIsolation !== true
    || value.piiReleasePolicy !== 'target-scoped-short-lived'
    || typeof value.resolveAuthors !== 'function') {
    throw new Error('submission_identity_resolver_port_invalid');
  }
  return value;
}
