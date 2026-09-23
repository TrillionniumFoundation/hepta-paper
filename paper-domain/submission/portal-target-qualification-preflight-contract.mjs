import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES,
  buildPortalTargetQualificationRegistry,
  buildPortalTargetQualificationSubjectHash,
  verifyPortalTargetQualification,
  verifyPortalTargetQualificationEvidenceAttestation,
  verifyPortalTargetQualificationRegistryStructure,
} from './portal-target-qualification-contract.mjs';
import {
  getJournalSubmissionTargetProfile,
} from './journal-submission-target-registry.mjs';
import {
  inspectPortalTargetQualificationPreflightContinuity,
} from './portal-target-qualification-preflight-continuity.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EVIDENCE_TYPES = Object.freeze(
  Object.keys(PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES),
);

function blocker(errorCode, blockerType, targetVenueId = null, evidenceType = null) {
  return Object.freeze({
    version: 1,
    kind: 'PortalTargetQualificationPreflightBlocker',
    errorCode,
    blockerType,
    targetVenueId,
    evidenceType,
  });
}

function uniqueBlockers(blockers) {
  const unique = new Map(blockers.map((item) => [[
    item.targetVenueId || '',
    item.evidenceType || '',
    item.blockerType,
    item.errorCode,
  ].join('\u0000'), item]));
  return Object.freeze([...unique.values()].sort((left, right) => (
    String(left.targetVenueId || '').localeCompare(String(right.targetVenueId || ''))
      || String(left.evidenceType || '').localeCompare(String(right.evidenceType || ''))
      || left.errorCode.localeCompare(right.errorCode)
  )));
}

function addForProfiles(blockers, profiles, errorCode, blockerType, evidenceType = null) {
  if (!errorCode) return;
  for (const profile of profiles) {
    blockers.push(blocker(errorCode, blockerType, profile.venueId, evidenceType));
  }
}

function selectProfiles(targetVenueIds, blockers) {
  const requested = Array.isArray(targetVenueIds)
    ? targetVenueIds.map((venueId) => String(venueId || '').trim()) : [];
  if (requested.length < 1 || requested.length > 2) {
    blockers.push(blocker(
      'portal_target_qualification_preflight_target_count_invalid',
      'selection',
    ));
    return Object.freeze([]);
  }
  if (requested.some((venueId) => !venueId)
    || new Set(requested).size !== requested.length) {
    blockers.push(blocker(
      'portal_target_qualification_preflight_target_selection_invalid',
      'selection',
    ));
    return Object.freeze([]);
  }
  const profiles = [];
  for (const venueId of requested) {
    try { profiles.push(getJournalSubmissionTargetProfile(venueId)); }
    catch {
      blockers.push(blocker(
        'portal_target_qualification_preflight_target_unknown',
        'selection',
      ));
    }
  }
  return Object.freeze(profiles);
}

function expectedBinding(bindings, venueId) {
  if (bindings instanceof Map) return bindings.get(venueId) || null;
  if (Array.isArray(bindings)) {
    return bindings.find((item) => item?.venueId === venueId) || null;
  }
  return bindings && typeof bindings === 'object' && Object.hasOwn(bindings, venueId)
    ? bindings[venueId] : null;
}

function normalizedPin(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).toLowerCase();
}

function authorityBlockerPolicy(rawBlocker) {
  if (rawBlocker.includes('authority_spki_not_independent')) {
    return ['portal_target_qualification_preflight_issuer_spki_not_independent',
      'authority_independence'];
  }
  if (rawBlocker.includes('authority_organizations_not_independent')) {
    return ['portal_target_qualification_preflight_issuer_organization_not_independent',
      'authority_independence'];
  }
  if (rawBlocker.includes('authority_signers_must_be_distinct_subjects')) {
    return ['portal_target_qualification_preflight_issuer_subject_not_independent',
      'authority_independence'];
  }
  if (rawBlocker.includes('authority_trust_store_missing_or_invalid')) {
    return ['portal_target_qualification_preflight_trust_store_invalid', 'configuration'];
  }
  if (rawBlocker.includes('required_authority_role_missing')
    || rawBlocker.includes('signature_role_')
    || rawBlocker.includes('owner_mismatch')
    || rawBlocker.includes('observer_mismatch')
    || rawBlocker.includes('authorizer_mismatch')
    || rawBlocker.includes('verifier_identity_mismatch')) {
    return ['portal_target_qualification_preflight_issuer_role_mismatch', 'issuer_role'];
  }
  return ['portal_target_qualification_preflight_signature_verification_failed',
    'issuer_role'];
}

function addAuthorityBlockers(blockers, profiles, rawBlockers) {
  for (const rawBlocker of rawBlockers) {
    const [errorCode, blockerType] = authorityBlockerPolicy(rawBlocker);
    const selected = profiles.find(({ venueId }) => (
      rawBlocker.startsWith(`${venueId}:`) || rawBlocker.includes(`:${venueId}`)
    ));
    const evidenceType = EVIDENCE_TYPES.find((type) => (
      rawBlocker.includes(`:${type}:`) || rawBlocker.endsWith(`:${type}`)
    )) || null;
    addForProfiles(
      blockers,
      selected ? [selected] : profiles,
      errorCode,
      blockerType,
      evidenceType,
    );
  }
}

function addSourceBlockers({
  blockers,
  profiles,
  activeSource,
  candidateSource,
  trustSource,
  registryPin,
  candidatePin,
  trustPin,
} = {}) {
  const candidateSelected = candidateSource.configured === true;
  const source = candidateSelected ? candidateSource : activeSource;
  if (!candidateSelected && (!activeSource.configured || activeSource.missing)) {
    addForProfiles(blockers, profiles,
      'portal_target_qualification_preflight_registry_missing', 'configuration');
  } else if (!candidateSelected && !activeSource.readable) {
    addForProfiles(blockers, profiles,
      'portal_target_qualification_preflight_registry_file_invalid', 'configuration');
  }
  if (candidateSelected && candidateSource.missing) {
    addForProfiles(blockers, profiles,
      'portal_target_qualification_preflight_candidate_missing', 'configuration');
  } else if (candidateSelected && !candidateSource.readable) {
    addForProfiles(blockers, profiles,
      'portal_target_qualification_preflight_candidate_file_invalid', 'configuration');
  }
  if (candidateSelected && registryPin.configured
    && (!activeSource.configured || activeSource.missing
      || !activeSource.readable || activeSource.contractValid === false)) {
    addForProfiles(blockers, profiles,
      'portal_target_qualification_preflight_current_registry_invalid', 'configuration');
  }
  if (source.configured && (!trustSource.configured || trustSource.missing)) {
    addForProfiles(blockers, profiles,
      'portal_target_qualification_preflight_trust_store_missing', 'configuration');
  } else if (source.configured && !trustSource.readable) {
    addForProfiles(blockers, profiles,
      'portal_target_qualification_preflight_trust_store_invalid', 'configuration');
  }
  if (!candidateSelected && activeSource.readable) {
    addForProfiles(blockers, profiles,
      !registryPin.configured || !registryPin.valid
        ? 'portal_target_qualification_preflight_registry_pin_missing'
        : !registryPin.matched
          ? 'portal_target_qualification_preflight_registry_pin_drift' : null,
      'pin_drift');
  } else if (candidateSelected && registryPin.configured
    && (!registryPin.valid || !registryPin.matched)) {
    addForProfiles(blockers, profiles,
      'portal_target_qualification_preflight_registry_pin_drift', 'pin_drift');
  }
  if (candidateSelected) {
    addForProfiles(blockers, profiles,
      !candidatePin.configured || !candidatePin.valid
        ? 'portal_target_qualification_preflight_candidate_pin_missing'
        : candidateSource.readable && !candidatePin.matched
          ? 'portal_target_qualification_preflight_candidate_pin_drift' : null,
      'pin_drift');
  }
  if (trustSource.readable) {
    addForProfiles(blockers, profiles,
      !trustPin.configured || !trustPin.valid
        ? 'portal_target_qualification_preflight_trust_store_pin_missing'
        : !trustPin.matched
          ? 'portal_target_qualification_preflight_trust_store_pin_drift' : null,
      'pin_drift');
  }
  return source;
}

function addIf(blockers, condition, errorCode, blockerType, venueId, evidenceType = null) {
  if (condition) blockers.push(blocker(errorCode, blockerType, venueId, evidenceType));
}

function inspectTarget({
  profile,
  registry,
  binding,
  requestedLevel,
  nowMs,
  blockers,
} = {}) {
  const matches = Array.isArray(registry?.entries)
    ? registry.entries.filter((entry) => entry?.venueId === profile.venueId) : [];
  const entry = matches.length === 1 ? matches[0] : null;
  const venueId = profile.venueId;
  const requiredTypes = requestedLevel === 'sandbox'
    ? EVIDENCE_TYPES.slice(0, 3) : EVIDENCE_TYPES;
  addIf(blockers, !entry,
    'portal_target_qualification_preflight_target_missing', 'missing_evidence', venueId);
  addIf(blockers, matches.length > 1,
    'portal_target_qualification_preflight_target_duplicate', 'configuration', venueId);
  addIf(blockers, entry && !verifyPortalTargetQualification(entry),
    'portal_target_qualification_preflight_target_contract_invalid',
    'configuration', venueId);
  addIf(blockers, entry && (entry.liveCommitAuthorized !== false
      || entry.liveCommitPermitHash !== null
      || entry.humanSingleUseAuthorizationRequired !== true),
  'portal_target_qualification_preflight_live_authorization_forbidden',
  'safety', venueId);
  addIf(blockers, entry && requestedLevel === 'production'
      && (entry.qualificationLevel !== 'production' || entry.productionQualified !== true),
  'portal_target_qualification_preflight_production_qualification_missing',
  'missing_evidence', venueId);
  const qualifiedAtMs = Date.parse(String(entry?.qualifiedAt || ''));
  const expiresAtMs = Date.parse(String(entry?.expiresAt || ''));
  addIf(blockers, entry && Number.isFinite(qualifiedAtMs) && nowMs < qualifiedAtMs,
    'portal_target_qualification_preflight_target_not_yet_valid', 'expiration', venueId);
  addIf(blockers, entry && Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs,
    'portal_target_qualification_preflight_target_expired', 'expiration', venueId);

  let canonicalSubjectHash = null;
  if (entry) {
    try { canonicalSubjectHash = buildPortalTargetQualificationSubjectHash(entry); }
    catch { /* represented by the subject blocker below */ }
    addIf(blockers, !canonicalSubjectHash
        || entry.portalTargetSubjectHash !== canonicalSubjectHash,
    'portal_target_qualification_preflight_subject_mismatch',
    'binding_mismatch', venueId);
  }
  const subjectPin = normalizedPin(binding?.portalTargetSubjectHash);
  const routePin = normalizedPin(binding?.submissionRouteHash);
  const schemaPin = normalizedPin(binding?.schemaFingerprintHash);
  addIf(blockers, [subjectPin, routePin, schemaPin]
    .some((pin) => pin !== null && !SHA256.test(pin)),
  'portal_target_qualification_preflight_expected_binding_invalid',
  'configuration', venueId);
  addIf(blockers, entry && SHA256.test(subjectPin || '')
      && entry.portalTargetSubjectHash !== subjectPin,
  'portal_target_qualification_preflight_subject_mismatch',
  'binding_mismatch', venueId);
  addIf(blockers, entry && SHA256.test(routePin || '')
      && entry.submissionRouteHash !== routePin,
  'portal_target_qualification_preflight_route_mismatch',
  'binding_mismatch', venueId);
  addIf(blockers, entry && SHA256.test(schemaPin || '')
      && entry.schemaFingerprintHash !== schemaPin,
  'portal_target_qualification_preflight_schema_mismatch',
  'binding_mismatch', venueId);

  const evidence = EVIDENCE_TYPES.map((evidenceType) => {
    const policy = PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES[evidenceType];
    const item = entry?.evidence?.[evidenceType] || null;
    const required = requiredTypes.includes(evidenceType);
    addIf(blockers, required && !item,
      'portal_target_qualification_preflight_evidence_missing',
      'missing_evidence', venueId, evidenceType);
    addIf(blockers, item && !verifyPortalTargetQualificationEvidenceAttestation(
      item, { evidenceType },
    ), 'portal_target_qualification_preflight_evidence_policy_mismatch',
    'binding_mismatch', venueId, evidenceType);
    addIf(blockers, item && canonicalSubjectHash
        && item.subjectHash !== canonicalSubjectHash,
    'portal_target_qualification_preflight_subject_mismatch',
    'binding_mismatch', venueId, evidenceType);
    addIf(blockers, item && item.verifierRole !== policy.authorityRole,
      'portal_target_qualification_preflight_issuer_role_mismatch',
      'issuer_role', venueId, evidenceType);
    addIf(blockers, item && item.liveCommitPerformed !== false,
      'portal_target_qualification_preflight_live_authorization_forbidden',
      'safety', venueId, evidenceType);
    const observedAtMs = Date.parse(String(item?.observedAt || ''));
    const evidenceExpiresAtMs = Date.parse(String(item?.expiresAt || ''));
    addIf(blockers, item && Number.isFinite(observedAtMs) && nowMs < observedAtMs,
      'portal_target_qualification_preflight_evidence_not_yet_valid',
      'expiration', venueId, evidenceType);
    addIf(blockers, item && Number.isFinite(evidenceExpiresAtMs)
        && nowMs >= evidenceExpiresAtMs,
    'portal_target_qualification_preflight_evidence_expired',
    'expiration', venueId, evidenceType);
    addIf(blockers, item && Number.isFinite(observedAtMs)
        && nowMs - observedAtMs > policy.maximumAgeMs,
    'portal_target_qualification_preflight_evidence_stale',
    'expiration', venueId, evidenceType);
    return Object.freeze({
      evidenceType,
      required,
      present: item !== null,
      current: item !== null
        && Number.isFinite(observedAtMs)
        && Number.isFinite(evidenceExpiresAtMs)
        && nowMs >= observedAtMs
        && nowMs < evidenceExpiresAtMs
        && nowMs - observedAtMs <= policy.maximumAgeMs,
    });
  });
  return Object.freeze({
    profile,
    entry,
    evidence: Object.freeze(evidence),
    subjectPinConfigured: SHA256.test(subjectPin || ''),
    subjectPinMatched: SHA256.test(subjectPin || '')
      ? entry?.portalTargetSubjectHash === subjectPin : null,
    routePinConfigured: SHA256.test(routePin || ''),
    routePinMatched: SHA256.test(routePin || '')
      ? entry?.submissionRouteHash === routePin : null,
    schemaPinConfigured: SHA256.test(schemaPin || ''),
    schemaPinMatched: SHA256.test(schemaPin || '')
      ? entry?.schemaFingerprintHash === schemaPin : null,
  });
}

function normalizedRegistry(document) {
  return verifyPortalTargetQualificationRegistryStructure(document)
    ? buildPortalTargetQualificationRegistry(document) : null;
}

function continuityBlockerType(errorCode) {
  return /_(subject|route|schema)_mismatch$/u.test(errorCode)
    ? 'binding_mismatch' : 'continuity_drift';
}

export function buildPortalTargetQualificationPreflightPlan({
  targetVenueIds = [],
  requestedQualificationLevel = 'production',
  expectedTargetBindings = {},
  activeSource = {},
  candidateSource = {},
  trustSource = {},
  registryPin = {},
  candidatePin = {},
  trustPin = {},
  authorityVerificationBlockers = [],
  now = null,
} = {}) {
  const blockers = [];
  const profiles = selectProfiles(targetVenueIds, blockers);
  const requestedLevel = ['sandbox', 'production'].includes(requestedQualificationLevel)
    ? requestedQualificationLevel : 'production';
  addIf(blockers, requestedLevel !== requestedQualificationLevel,
    'portal_target_qualification_preflight_level_invalid', 'selection', null);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  addIf(blockers, !Number.isFinite(nowMs),
    'portal_target_qualification_preflight_clock_invalid', 'configuration', null);
  const source = addSourceBlockers({
    blockers,
    profiles,
    activeSource,
    candidateSource,
    trustSource,
    registryPin,
    candidatePin,
    trustPin,
  });
  const candidateSelected = candidateSource.configured === true;
  const registry = source.document || null;
  const normalized = normalizedRegistry(registry);
  if (registry && !normalized) {
    addForProfiles(blockers, profiles, candidateSource.configured
      ? 'portal_target_qualification_preflight_candidate_contract_invalid'
      : 'portal_target_qualification_preflight_registry_contract_invalid',
    'configuration');
  }
  if (registry) {
    addForProfiles(blockers, profiles,
      Array.isArray(registry.entries) && registry.entries.length <= 2
        && registry.maximumTargetCount === 2 ? null
        : 'portal_target_qualification_preflight_overlay_target_limit_exceeded',
      'selection');
    addForProfiles(blockers, profiles,
      registry.liveCommitAuthorizationIncluded === false
        && registry.humanSingleUseAuthorizationRequired === true ? null
        : 'portal_target_qualification_preflight_live_authorization_forbidden',
      'safety');
    const issuedAtMs = Date.parse(String(registry.issuedAt || ''));
    const expiresAtMs = Date.parse(String(registry.expiresAt || ''));
    addForProfiles(blockers, profiles,
      Number.isFinite(issuedAtMs) && nowMs < issuedAtMs
        ? 'portal_target_qualification_preflight_registry_not_yet_valid' : null,
      'expiration');
    addForProfiles(blockers, profiles,
      Number.isFinite(expiresAtMs) && nowMs >= expiresAtMs
        ? 'portal_target_qualification_preflight_registry_expired' : null,
      'expiration');
  }
  if (candidateSelected && normalized) {
    const selectedVenueIds = profiles.map(({ venueId }) => venueId).sort();
    const candidateVenueIds = normalized.entries.map(({ venueId }) => venueId).sort();
    addIf(blockers,
      JSON.stringify(selectedVenueIds) !== JSON.stringify(candidateVenueIds),
      'portal_target_qualification_preflight_candidate_target_set_mismatch',
      'selection', null);
  }
  addAuthorityBlockers(blockers, profiles, authorityVerificationBlockers);
  const current = normalizedRegistry(activeSource.document);
  const candidate = normalizedRegistry(candidateSource.document);
  if (candidateSource.configured && candidate) {
    for (const finding of inspectPortalTargetQualificationPreflightContinuity({
      currentRegistry: current,
      candidateRegistry: candidate,
    })) {
      const selected = profiles.find(({ venueId }) => venueId === finding.targetVenueId);
      addForProfiles(blockers, selected ? [selected] : profiles,
        finding.errorCode, continuityBlockerType(finding.errorCode));
    }
  }
  const inspections = profiles.map((profile) => inspectTarget({
    profile,
    registry,
    binding: expectedBinding(expectedTargetBindings, profile.venueId),
    requestedLevel,
    nowMs,
    blockers,
  }));
  const typedBlockers = uniqueBlockers(blockers);
  const globalBlocked = typedBlockers.some((item) => item.targetVenueId === null);
  const targets = Object.freeze(inspections.map((inspection) => {
    const targetBlockers = Object.freeze(typedBlockers.filter(
      (item) => item.targetVenueId === inspection.profile.venueId,
    ));
    const recognized = !globalBlocked && targetBlockers.length === 0;
    return Object.freeze({
      version: 1,
      kind: 'PortalTargetQualificationPreflightTarget',
      venueId: inspection.profile.venueId,
      venueKind: inspection.profile.venueKind,
      discoveryLane: inspection.profile.discoveryLane,
      connectorFamily: inspection.entry?.connectorFamily
        || inspection.profile.selectedConnectorFamily,
      requestedQualificationLevel: requestedLevel,
      overlayPresent: inspection.entry !== null,
      subjectPinConfigured: inspection.subjectPinConfigured,
      subjectPinMatched: inspection.subjectPinMatched,
      routePinConfigured: inspection.routePinConfigured,
      routePinMatched: inspection.routePinMatched,
      schemaPinConfigured: inspection.schemaPinConfigured,
      schemaPinMatched: inspection.schemaPinMatched,
      evidence: inspection.evidence,
      sandboxQualified: !candidateSelected
        && recognized && inspection.entry?.sandboxQualified === true,
      productionQualified: !candidateSelected
        && recognized && inspection.entry?.productionQualified === true,
      candidateSandboxQualificationVerified: candidateSelected
        && recognized && inspection.entry?.sandboxQualified === true,
      candidateProductionQualificationVerified: candidateSelected
        && recognized && inspection.entry?.productionQualified === true,
      liveCommitAuthorized: false,
      liveSubmissionReady: false,
      blockers: targetBlockers,
    });
  }));
  const ready = typedBlockers.length === 0 && targets.length > 0
    && targets.length <= 2 && normalized !== null;
  const payload = Object.freeze({
    version: 1,
    kind: 'PortalTargetQualificationPreflightPlan',
    status: ready ? 'portal_target_qualification_preflight_ready'
      : 'portal_target_qualification_preflight_blocked',
    ready,
    source: candidateSelected ? 'candidate_registry' : 'active_registry',
    requestedQualificationLevel: requestedLevel,
    selectedTargetCount: targets.length,
    registry: Object.freeze({
      activeConfigured: activeSource.configured === true,
      candidateConfigured: candidateSelected,
      sourceReadable: source.readable === true,
      sourceContractValid: normalized !== null,
      sourcePinConfigured: candidateSelected
        ? candidatePin.configured === true && candidatePin.valid === true
        : registryPin.configured === true && registryPin.valid === true,
      sourcePinMatched: candidateSelected
        ? candidatePin.matched === true : registryPin.matched === true,
      trustStoreConfigured: trustSource.configured === true,
      trustStoreReadable: trustSource.readable === true,
      trustStorePinConfigured: trustPin.configured === true && trustPin.valid === true,
      trustStorePinMatched: trustPin.matched === true,
      generation: normalized?.generation || null,
      overlayTargetCount: normalized?.entries.length || 0,
      maximumTargetCount: 2,
      liveCommitAuthorizationIncluded: false,
      humanSingleUseAuthorizationRequired: true,
    }),
    targets,
    blockers: typedBlockers,
    safety: Object.freeze({
      readOnly: true,
      mutationPerformed: false,
      registryProduced: false,
      evidenceProduced: false,
      networkActionPerformed: false,
      credentialUsed: false,
      portalLoginPerformed: false,
      uploadPerformed: false,
      signatureProduced: false,
      authorizationProduced: false,
      liveCommitAuthorized: false,
      liveCommitPermitProduced: false,
      liveCommitPermitConsumed: false,
    }),
  });
  return Object.freeze({
    ...payload,
    preflightPlanHash: hashRecord('PortalTargetQualificationPreflightPlan', payload),
  });
}
