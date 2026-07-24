import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const FAMILY_KEYS = Object.freeze([
  'authenticationModes',
  'blindCommitRetryPermitted',
  'browserAutomation',
  'capabilities',
  'captchaBypassPermitted',
  'connectorFamily',
  'credentialIsolationRequired',
  'finalCommitSupported',
  'humanFinalReviewRequired',
  'implementationStatus',
  'kind',
  'productionQualified',
  'receiptAuthority',
  'schemaStrategy',
  'transport',
  'unknownDeclarationsBlockCommit',
  'version',
]);

const CAPABILITY_KEYS = Object.freeze([
  'commit',
  'createDraft',
  'discoverProfile',
  'dryRun',
  'fillMetadata',
  'getReceipt',
  'getStatus',
  'preview',
  'reconcile',
  'uploadAssets',
  'validate',
]);

function connectorFamily({
  connectorFamily: family,
  transport,
  implementationStatus,
  authenticationModes,
  schemaStrategy,
  receiptAuthority,
  browserAutomation = false,
  finalCommitSupported = false,
  capabilities = {},
} = {}) {
  const selectedCapabilities = Object.freeze(Object.fromEntries(
    CAPABILITY_KEYS.map((key) => [key, capabilities[key] === true]),
  ));
  const payload = {
    version: 1,
    kind: 'SubmissionConnectorFamily',
    connectorFamily: String(family),
    transport: String(transport),
    implementationStatus: String(implementationStatus),
    authenticationModes: Object.freeze([...authenticationModes]),
    schemaStrategy: String(schemaStrategy),
    receiptAuthority: String(receiptAuthority),
    browserAutomation: browserAutomation === true,
    finalCommitSupported: finalCommitSupported === true,
    capabilities: selectedCapabilities,
    credentialIsolationRequired: true,
    humanFinalReviewRequired: true,
    unknownDeclarationsBlockCommit: true,
    blindCommitRetryPermitted: false,
    captchaBypassPermitted: false,
    productionQualified: false,
  };
  return Object.freeze({
    ...payload,
    submissionConnectorFamilyHash:
      hashRecord('SubmissionConnectorFamily', payload),
  });
}

const FULL_API = Object.freeze({
  discoverProfile: true,
  validate: true,
  createDraft: true,
  uploadAssets: true,
  fillMetadata: true,
  preview: true,
  commit: true,
  getReceipt: true,
  getStatus: true,
  reconcile: true,
});

const FAMILIES = Object.freeze([
  connectorFamily({
    connectorFamily: 'openreview-api-v2',
    transport: 'official-api',
    implementationStatus: 'prototype-adapter-present',
    authenticationModes: ['api-token', 'isolated-session'],
    schemaStrategy: 'dynamic-invitation-schema',
    receiptAuthority: 'independent-signed-connector-attestation-required',
    finalCommitSupported: true,
    capabilities: FULL_API,
  }),
  connectorFamily({
    connectorFamily: 'hotcrp-rest-v1',
    transport: 'official-api',
    implementationStatus: 'prototype-adapter-present',
    authenticationModes: ['bearer-token'],
    schemaStrategy: 'edition-openapi-plus-settings-discovery',
    receiptAuthority: 'independent-signed-connector-attestation-required',
    finalCommitSupported: true,
    capabilities: { ...FULL_API, dryRun: true },
  }),
  connectorFamily({
    connectorFamily: 'ojs-rest-v1',
    transport: 'official-api',
    implementationStatus: 'prototype-adapter-present',
    authenticationModes: ['api-token'],
    schemaStrategy: 'instance-version-plus-workflow-schema',
    receiptAuthority: 'independent-signed-connector-attestation-required',
    finalCommitSupported: true,
    capabilities: { ...FULL_API, dryRun: true },
  }),
  connectorFamily({
    connectorFamily: 'scholarone-submission-integration-v1',
    transport: 'official-partner-integration',
    implementationStatus: 'publisher-authorization-required',
    authenticationModes: ['partner-s3-credential', 'partner-client-key'],
    schemaStrategy: 'journal-authorized-go-jats-package-profile',
    receiptAuthority: 'partner-notification-plus-independent-attestation',
    finalCommitSupported: true,
    capabilities: FULL_API,
  }),
  connectorFamily({
    connectorFamily: 'arxiv-sword-v1',
    transport: 'official-authorized-api',
    implementationStatus: 'platform-authorization-required',
    authenticationModes: ['authorized-sword-account'],
    schemaStrategy: 'sword-collection-service-document',
    receiptAuthority: 'provider-receipt-plus-independent-attestation',
    finalCommitSupported: true,
    capabilities: FULL_API,
  }),
  connectorFamily({
    connectorFamily: 'playwright-assisted-draft-v1',
    transport: 'browser-assisted',
    implementationStatus: 'prototype-adapter-present',
    authenticationModes: ['human-session-handoff'],
    schemaStrategy: 'versioned-dom-fingerprint-and-semantic-selectors',
    receiptAuthority: 'independent-execution-attestation',
    browserAutomation: true,
    finalCommitSupported: false,
    capabilities: {
      discoverProfile: true,
      validate: true,
      createDraft: true,
      uploadAssets: true,
      fillMetadata: true,
      preview: true,
      getStatus: true,
      reconcile: true,
    },
  }),
  connectorFamily({
    connectorFamily: 'manual-handoff-v1',
    transport: 'human-operated',
    implementationStatus: 'manual-only',
    authenticationModes: ['human-session'],
    schemaStrategy: 'operator-reviewed-checklist',
    receiptAuthority: 'human-supplied-provider-evidence',
    capabilities: {
      validate: true,
      preview: true,
      getReceipt: true,
      getStatus: true,
      reconcile: true,
    },
  }),
  connectorFamily({
    connectorFamily: 'portal-schema-discovery-required-v1',
    transport: 'none',
    implementationStatus: 'discovery-required',
    authenticationModes: [],
    schemaStrategy: 'no-binding-until-evidence-backed-discovery',
    receiptAuthority: 'unavailable',
    capabilities: {},
  }),
]);

export function verifySubmissionConnectorFamily(value) {
  const { submissionConnectorFamilyHash: claimedHash, ...payload } = value || {};
  if (!hasExactObjectKeys(payload, FAMILY_KEYS)
    || !hasExactObjectKeys(payload.capabilities, CAPABILITY_KEYS)
    || claimedHash !== hashRecord('SubmissionConnectorFamily', payload)
    || payload.version !== 1
    || payload.kind !== 'SubmissionConnectorFamily'
    || !payload.connectorFamily
    || !Array.isArray(payload.authenticationModes)
    || payload.productionQualified !== false
    || payload.credentialIsolationRequired !== true
    || payload.humanFinalReviewRequired !== true
    || payload.unknownDeclarationsBlockCommit !== true
    || payload.blindCommitRetryPermitted !== false
    || payload.captchaBypassPermitted !== false
    || (payload.finalCommitSupported !== payload.capabilities.commit)
    || (payload.browserAutomation && payload.finalCommitSupported)) return false;
  return true;
}

export function buildSubmissionConnectorFamilyRegistry({
  families = FAMILIES,
} = {}) {
  if (!Array.isArray(families) || !families.length
    || families.some((family) => !verifySubmissionConnectorFamily(family))) {
    throw new Error('submission_connector_family_registry_invalid');
  }
  const selected = Object.freeze([...families].sort((left, right) => (
    left.connectorFamily.localeCompare(right.connectorFamily)
  )));
  if (new Set(selected.map((family) => family.connectorFamily)).size !== selected.length) {
    throw new Error('submission_connector_family_registry_duplicate');
  }
  const payload = {
    version: 1,
    kind: 'SubmissionConnectorFamilyRegistry',
    status: 'submission_connector_family_registry_ready',
    familyCount: selected.length,
    prototypeAdapterFamilyCount:
      selected.filter((family) => (
        family.implementationStatus === 'prototype-adapter-present'
      )).length,
    productionQualifiedFamilyCount:
      selected.filter((family) => family.productionQualified).length,
    families: selected,
  };
  return Object.freeze({
    ...payload,
    submissionConnectorFamilyRegistryHash:
      hashRecord('SubmissionConnectorFamilyRegistry', payload),
  });
}

export const SUBMISSION_CONNECTOR_FAMILY_REGISTRY =
  buildSubmissionConnectorFamilyRegistry();

export function getSubmissionConnectorFamily(connectorFamily, {
  registry = SUBMISSION_CONNECTOR_FAMILY_REGISTRY,
} = {}) {
  const selected = registry.families.find((family) => (
    family.connectorFamily === connectorFamily
  ));
  if (!selected) throw new Error(`submission_connector_family_unknown:${connectorFamily}`);
  return selected;
}
