export function assertOjsClientPort(value) {
  if (value?.kind !== 'OjsClientPort'
    || value.networkPolicy !== 'ojs-only'
    || value.credentialIsolation !== true
    || typeof value.probe !== 'function'
    || typeof value.getSubmissionSchema !== 'function'
    || typeof value.validatePlan !== 'function'
    || typeof value.createSubmission !== 'function'
    || typeof value.updatePublication !== 'function'
    || typeof value.replaceContributors !== 'function'
    || typeof value.uploadFiles !== 'function'
    || typeof value.saveForLater !== 'function'
    || typeof value.submitSubmission !== 'function'
    || typeof value.getSubmission !== 'function') {
    throw new Error('ojs_client_port_invalid');
  }
  return value;
}
