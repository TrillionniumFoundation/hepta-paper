import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  getSubmissionConnectorFamily,
} from './submission-connector-family-registry.mjs';
import {
  getJournalSubmissionTargetProfile,
} from './journal-submission-target-registry.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const BINDING_KEYS = Object.freeze([
  'authenticationMode',
  'authenticationProfileHash',
  'automationPolicyEvidenceHash',
  'baseTargetProfileHash',
  'blindCommitRetryPermitted',
  'captchaBypassPermitted',
  'connectorFamily',
  'edition',
  'enabledOperations',
  'expiresAt',
  'finalCommitRequiresHumanReview',
  'kind',
  'liveCommitAuthorized',
  'portalBindingEvidenceHashes',
  'portalOrigin',
  'productionQualified',
  'schemaEvidenceHashes',
  'schemaFingerprintHash',
  'status',
  'statusMappingHash',
  'submissionRoute',
  'targetInstanceId',
  'termsAutomationPermitted',
  'track',
  'venueId',
  'venueKind',
  'verifiedAt',
  'version',
]);

function canonicalInstant(value) {
  const candidate = String(value || '');
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === candidate
    ? candidate : null;
}

function hashes(values, code) {
  if (!Array.isArray(values) || !values.length || values.length > 64) {
    throw new Error(code);
  }
  const selected = [...new Set(values.map((value) => String(value || '').toLowerCase()))]
    .sort();
  if (selected.length !== values.length || selected.some((value) => !SHA256.test(value))) {
    throw new Error(code);
  }
  return Object.freeze(selected);
}

function route(value) {
  const selected = String(value || '').trim();
  if (!selected.startsWith('/') || selected.startsWith('//')
    || selected.includes('#') || selected.length > 2_048) {
    throw new Error('submission_portal_route_invalid');
  }
  return selected;
}

export function buildSubmissionPortalBinding({
  baseTargetProfile,
  targetInstanceId,
  edition = null,
  track = null,
  connectorFamily,
  portalOrigin,
  submissionRoute,
  authenticationMode,
  authenticationProfileHash,
  schemaFingerprintHash,
  schemaEvidenceHashes,
  automationPolicyEvidenceHash,
  portalBindingEvidenceHashes,
  statusMappingHash,
  enabledOperations,
  termsAutomationPermitted = false,
  verifiedAt,
  expiresAt,
} = {}) {
  const {
    journalSubmissionTargetProfileHash: claimedTargetProfileHash,
    ...targetProfilePayload
  } = baseTargetProfile || {};
  let currentTargetProfile = null;
  try {
    currentTargetProfile = getJournalSubmissionTargetProfile(baseTargetProfile?.venueId);
  } catch {
    throw new Error('submission_portal_binding_target_profile_not_current');
  }
  if (baseTargetProfile?.version !== 1
    || baseTargetProfile?.kind !== 'JournalSubmissionTargetProfile'
    || !SHA256.test(String(claimedTargetProfileHash || ''))
    || claimedTargetProfileHash
      !== hashRecord('JournalSubmissionTargetProfile', targetProfilePayload)
    || claimedTargetProfileHash
      !== currentTargetProfile.journalSubmissionTargetProfileHash
    || !SAFE_ID.test(String(targetInstanceId || ''))
    || !['conference', 'journal'].includes(baseTargetProfile?.venueKind)
    || !baseTargetProfile.candidateConnectorFamilies?.includes(connectorFamily)
    || !SHA256.test(String(authenticationProfileHash || '').toLowerCase())
    || !SHA256.test(String(schemaFingerprintHash || '').toLowerCase())
    || !SHA256.test(String(automationPolicyEvidenceHash || '').toLowerCase())
    || !SHA256.test(String(statusMappingHash || '').toLowerCase())) {
    throw new Error('submission_portal_binding_input_invalid');
  }
  const selectedEdition = edition === null ? null : String(edition || '').trim();
  const selectedTrack = track === null ? null : String(track || '').trim();
  if (baseTargetProfile.venueKind === 'conference'
    && (!selectedEdition || !selectedTrack)) {
    throw new Error('submission_portal_binding_conference_edition_required');
  }
  if ((selectedEdition && selectedEdition.length > 128)
    || (selectedTrack && selectedTrack.length > 256)) {
    throw new Error('submission_portal_binding_edition_invalid');
  }
  let origin;
  try {
    const parsed = new URL(String(portalOrigin || ''));
    if (parsed.protocol !== 'https:' || parsed.pathname !== '/'
      || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error('invalid');
    }
    origin = parsed.origin;
  } catch {
    throw new Error('submission_portal_origin_invalid');
  }
  const family = getSubmissionConnectorFamily(connectorFamily);
  if (!family.authenticationModes.includes(authenticationMode)) {
    throw new Error('submission_portal_authentication_mode_unsupported');
  }
  if (!Array.isArray(enabledOperations) || !enabledOperations.length
    || new Set(enabledOperations).size !== enabledOperations.length
    || enabledOperations.some((operation) => family.capabilities[operation] !== true)) {
    throw new Error('submission_portal_operations_invalid');
  }
  const operations = Object.freeze([...enabledOperations].sort());
  if (operations.includes('commit')
    && (!family.finalCommitSupported || termsAutomationPermitted !== true)) {
    throw new Error('submission_portal_commit_policy_not_verified');
  }
  const selectedVerifiedAt = canonicalInstant(verifiedAt);
  const selectedExpiresAt = canonicalInstant(expiresAt);
  if (!selectedVerifiedAt || !selectedExpiresAt
    || Date.parse(selectedExpiresAt) <= Date.parse(selectedVerifiedAt)) {
    throw new Error('submission_portal_binding_validity_invalid');
  }
  const payload = {
    version: 1,
    kind: 'SubmissionPortalBinding',
    status: operations.includes('commit')
      ? 'submission_portal_binding_commit_capable_not_authorized'
      : 'submission_portal_binding_draft_only',
    venueId: baseTargetProfile.venueId,
    venueKind: baseTargetProfile.venueKind,
    baseTargetProfileHash: baseTargetProfile.journalSubmissionTargetProfileHash,
    targetInstanceId: String(targetInstanceId),
    edition: selectedEdition,
    track: selectedTrack,
    connectorFamily: family.connectorFamily,
    portalOrigin: origin,
    submissionRoute: route(submissionRoute),
    authenticationMode: String(authenticationMode),
    authenticationProfileHash: String(authenticationProfileHash).toLowerCase(),
    schemaFingerprintHash: String(schemaFingerprintHash).toLowerCase(),
    schemaEvidenceHashes: hashes(
      schemaEvidenceHashes, 'submission_portal_schema_evidence_invalid',
    ),
    automationPolicyEvidenceHash:
      String(automationPolicyEvidenceHash).toLowerCase(),
    portalBindingEvidenceHashes: hashes(
      portalBindingEvidenceHashes, 'submission_portal_binding_evidence_invalid',
    ),
    statusMappingHash: String(statusMappingHash).toLowerCase(),
    enabledOperations: operations,
    termsAutomationPermitted: termsAutomationPermitted === true,
    verifiedAt: selectedVerifiedAt,
    expiresAt: selectedExpiresAt,
    finalCommitRequiresHumanReview: true,
    blindCommitRetryPermitted: false,
    captchaBypassPermitted: false,
    productionQualified: false,
    liveCommitAuthorized: false,
  };
  return Object.freeze({
    ...payload,
    submissionPortalBindingHash:
      hashRecord('SubmissionPortalBinding', payload),
  });
}

export function verifySubmissionPortalBinding(value, {
  baseTargetProfile,
  observedAt = null,
} = {}) {
  const { submissionPortalBindingHash: claimedHash, ...payload } = value || {};
  if (!hasExactObjectKeys(payload, BINDING_KEYS)
    || claimedHash !== hashRecord('SubmissionPortalBinding', payload)
    || payload.baseTargetProfileHash
      !== baseTargetProfile?.journalSubmissionTargetProfileHash
    || payload.venueId !== baseTargetProfile?.venueId
    || payload.productionQualified !== false
    || payload.liveCommitAuthorized !== false
    || payload.finalCommitRequiresHumanReview !== true
    || payload.blindCommitRetryPermitted !== false
    || payload.captchaBypassPermitted !== false) return false;
  try {
    const rebuilt = buildSubmissionPortalBinding({
      baseTargetProfile,
      ...payload,
    });
    if (JSON.stringify(rebuilt) !== JSON.stringify(value)) return false;
  } catch { return false; }
  if (observedAt !== null) {
    const instant = canonicalInstant(observedAt);
    if (!instant || Date.parse(instant) < Date.parse(value.verifiedAt)
      || Date.parse(instant) >= Date.parse(value.expiresAt)) return false;
  }
  return true;
}
