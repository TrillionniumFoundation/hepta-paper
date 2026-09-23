import {
  getSubmissionConnectorFamily,
} from '../paper-domain/submission/submission-connector-family-registry.mjs';

const OPERATIONS = Object.freeze([
  'commit', 'createDraft', 'discoverProfile', 'fillMetadata', 'getReceipt',
  'getStatus', 'preview', 'probeReadiness', 'reconcile', 'uploadAssets', 'validate',
]);

export function assertSubmissionConnectorPort(value) {
  if (value?.kind !== 'SubmissionConnectorPort'
    || value.version !== 1
    || !value.connectorId
    || !value.connectorFamily
    || value.networkPolicy !== 'provider-scoped'
    || value.credentialIsolation !== true
    || value.finalCommitRequiresSingleUsePermit !== true
    || value.finalCommitRequiresHumanReview !== true
    || value.unknownDeclarationsBlockCommit !== true
    || value.blindCommitRetryPermitted !== false
    || value.captchaBypassPermitted !== false
    || value.independentExecutionAttestationRequired !== true
    || ![true, false].includes(value.productionEligible)
    || OPERATIONS.some((operation) => typeof value[operation] !== 'function')) {
    throw new Error('submission_connector_port_invalid');
  }
  const family = getSubmissionConnectorFamily(value.connectorFamily);
  if (value.submissionConnectorFamilyHash !== family.submissionConnectorFamilyHash
    || (value.productionEligible
      && value.independentExecutionAttestationSupported !== true)) {
    throw new Error('submission_connector_port_family_binding_invalid');
  }
  return value;
}
