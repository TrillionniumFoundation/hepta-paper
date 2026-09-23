import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOURNAL_SUBMISSION_TARGET_REGISTRY,
  buildJournalSubmissionTargetRegistry,
  getJournalSubmissionTargetProfile,
} from '../../paper-domain/submission/journal-submission-target-registry.mjs';
import {
  JOURNAL_PROFILE_DATASET,
  validateJournalProfileDataset,
} from '../../paper-domain/journal/journal-registry.mjs';
import {
  JOURNAL_PROFILES as V1_JOURNAL_PROFILES,
} from '../../paper-domain/journal/data/journal-profiles.v1.data.mjs';
import {
  resolveJournalProfile,
} from '../../paper-domain/journal/selection.mjs';
import {
  buildJournalConferenceRegistry,
  buildJournalTargetProfile,
  buildTargetSelectionPolicy,
} from '../../paper-domain/journal/contracts.mjs';
import {
  SUBMISSION_CONNECTOR_FAMILY_REGISTRY,
  getSubmissionConnectorFamily,
  verifySubmissionConnectorFamily,
} from '../../paper-domain/submission/submission-connector-family-registry.mjs';
import {
  buildSubmissionPortalBinding,
  verifySubmissionPortalBinding,
} from '../../paper-domain/submission/submission-portal-binding.mjs';
import {
  buildSubmissionEnvelope,
  buildSubmissionEnvelopePreflight,
  verifySubmissionEnvelope,
} from '../../paper-domain/submission/submission-envelope.mjs';
import {
  createSubmissionConnectorRouter,
} from '../../paper-adapters/submission/submission-connector-router.mjs';
import {
  hashRecord,
} from '../../workflow-kernel/record-hash.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

function portalBinding(target = getJournalSubmissionTargetProfile('iclr')) {
  return {
    target,
    binding: buildSubmissionPortalBinding({
      baseTargetProfile: target,
      targetInstanceId: 'ICLR.cc/2027/Conference',
      edition: '2027',
      track: 'Conference',
      connectorFamily: 'openreview-api-v2',
      portalOrigin: 'https://openreview.net',
      submissionRoute: '/group?id=ICLR.cc/2027/Conference',
      authenticationMode: 'api-token',
      authenticationProfileHash: sha('1'),
      schemaFingerprintHash: sha('2'),
      schemaEvidenceHashes: [sha('3')],
      automationPolicyEvidenceHash: sha('4'),
      portalBindingEvidenceHashes: [sha('5')],
      statusMappingHash: sha('6'),
      enabledOperations: [
        'commit', 'createDraft', 'discoverProfile', 'getStatus',
        'preview', 'reconcile', 'validate',
      ],
      termsAutomationPermitted: true,
      verifiedAt: '2026-07-24T00:00:00.000Z',
      expiresAt: '2026-08-24T00:00:00.000Z',
    }),
  };
}

function envelope(binding, declarationValue = 'unknown') {
  return buildSubmissionEnvelope({
    campaignId: 'campaign-1',
    paperId: 'paper-1',
    venueId: 'iclr',
    requestHash: sha('7'),
    portalBindingHash: binding.submissionPortalBindingHash,
    compiledPdfHash: sha('8'),
    title: 'A bounded universal submission fixture',
    abstract: 'The fixture exercises target, metadata and asset bindings.',
    articleType: 'research_article',
    keywords: ['submission', 'verification'],
    authors: [{
      authorId: 'author-1',
      givenName: 'Ada',
      familyName: 'Lovelace',
      displayName: 'Ada Lovelace',
      emailReference: 'credential-profile:author-1-email',
      orcid: '0000-0002-1825-0097',
      affiliations: [{
        affiliationId: 'affiliation-1',
        displayName: 'Analytical Engine Institute',
        rorId: 'https://ror.org/03yrm5c26',
        ringgoldId: null,
        countryCode: 'GB',
      }],
      creditRoles: ['Conceptualization', 'Writing – original draft'],
      correspondingAuthor: true,
      submittingAuthor: true,
    }],
    declarations: [{
      declarationId: 'conflict_of_interest',
      statement: 'The authors declare whether a conflict exists.',
      value: declarationValue,
      evidenceReference: null,
    }],
    reviewerPreferences: [],
    files: [{
      fileId: 'manuscript-pdf',
      role: 'manuscript',
      filename: 'manuscript.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      sha256: sha('8'),
      order: 1,
    }],
    dynamicAnswers: [{
      fieldId: 'submission_type',
      schemaFingerprintHash: sha('2'),
      valueType: 'string',
      valueStatus: 'answered',
      value: 'Research paper',
    }],
    createdAt: '2026-07-24T00:10:00.000Z',
  });
}

function connector() {
  const family = getSubmissionConnectorFamily('openreview-api-v2');
  const operation = async () => ({ status: 'fixture' });
  return Object.freeze({
    version: 1,
    kind: 'SubmissionConnectorPort',
    connectorId: 'openreview-fixture',
    connectorFamily: family.connectorFamily,
    submissionConnectorFamilyHash: family.submissionConnectorFamilyHash,
    networkPolicy: 'provider-scoped',
    credentialIsolation: true,
    finalCommitRequiresSingleUsePermit: true,
    finalCommitRequiresHumanReview: true,
    unknownDeclarationsBlockCommit: true,
    blindCommitRetryPermitted: false,
    captchaBypassPermitted: false,
    independentExecutionAttestationRequired: true,
    independentExecutionAttestationSupported: false,
    productionEligible: false,
    commit: operation,
    createDraft: operation,
    discoverProfile: operation,
    fillMetadata: operation,
    getReceipt: operation,
    getStatus: operation,
    preview: operation,
    probeReadiness: operation,
    reconcile: operation,
    uploadAssets: operation,
    validate: operation,
  });
}

test('target registry covers exactly 98 stable venue identities without fallback', () => {
  const registry = JOURNAL_SUBMISSION_TARGET_REGISTRY;
  assert.equal(registry.version, 1);
  assert.equal(registry.targetProfileCount, 98);
  assert.equal(registry.conferenceTargetCount, 38);
  assert.equal(registry.journalTargetCount, 60);
  assert.equal(registry.connectorFamilyPrototypeAvailableCount, 98);
  assert.equal(registry.conferenceConnectorFamilyPrototypeAvailableCount, 38);
  assert.equal(registry.journalConnectorFamilyPrototypeAvailableCount, 60);
  assert.equal(registry.prototypeAdapterPresentCount, 4);
  assert.equal(registry.discoveryRequiredCount, 98);
  assert.equal(registry.silentFallbackPermitted, false);
  assert.equal(new Set(registry.targets.map((target) => target.venueId)).size, 98);
  const splitTargets = [];
  for (const venueId of ['alt', 'colt']) {
    const target = getJournalSubmissionTargetProfile(venueId);
    splitTargets.push(target);
    assert.equal(target.version, 1);
    assert.equal(target.identityStatus, 'stable-venue-identity-known');
    assert.equal(target.connectorFamilyPrototypeAvailable, true);
    assert.equal(target.liveSubmissionReady, false);
    assert.equal(target.blockers.includes('venue_identity_split_required'), false);
  }
  assert.notEqual(splitTargets[0].journalProfileHash, splitTargets[1].journalProfileHash);
  assert.notEqual(
    splitTargets[0].journalSubmissionTargetProfileHash,
    splitTargets[1].journalSubmissionTargetProfileHash,
  );
  assert.throws(
    () => getJournalSubmissionTargetProfile('colt_alt'),
    /journal_submission_target_unknown:colt_alt/,
  );
  assert.throws(
    () => buildJournalSubmissionTargetRegistry({
      profiles: registry.targets.slice(0, 1).map((target) => ({
        id: target.venueId,
        label: target.venueLabel,
        kind: target.venueKind,
      })),
    }),
    /journal_submission_target_routing_orphan/,
  );
});

test('profile data v2 splits COLT and ALT while preserving v1 identity history', () => {
  assert.equal(V1_JOURNAL_PROFILES.length, 97);
  assert.equal(
    V1_JOURNAL_PROFILES.some((profile) => profile.id === 'colt_alt'),
    true,
  );
  assert.equal(JOURNAL_PROFILE_DATASET.version, 2);
  assert.equal(JOURNAL_PROFILE_DATASET.dataRequirements.version, 2);
  assert.equal(JOURNAL_PROFILE_DATASET.validation.version, 1);
  assert.equal(JOURNAL_PROFILE_DATASET.profiles.length, 98);
  assert.equal(
    JOURNAL_PROFILE_DATASET.profiles.some((profile) => profile.id === 'colt_alt'),
    false,
  );
  assert.equal(resolveJournalProfile({ target: 'COLT' }).id, 'colt');
  assert.equal(resolveJournalProfile({ target: 'ALT' }).id, 'alt');
  for (const target of [
    'colt_alt', 'COLT/ALT', 'colt-alt', 'colt / alt', 'ALT/COLT', 'colt+alt',
    'COLT and Algorithmic Learning Theory',
    'Conference on Learning Theory / Algorithmic Learning Theory',
  ]) {
    assert.throws(
      () => resolveJournalProfile({ target }),
      /journal_profile_identity_ambiguous/,
    );
    assert.throws(
      () => buildTargetSelectionPolicy({ target }),
      /journal_profile_identity_ambiguous/,
    );
  }
  assert.throws(
    () => resolveJournalProfile({ fallbackId: 'colt_alt' }),
    /journal_profile_identity_ambiguous:fallback/,
  );
  assert.throws(
    () => buildTargetSelectionPolicy({ fallbackId: 'colt_alt' }),
    /journal_profile_identity_ambiguous:fallback/,
  );
  assert.throws(
    () => resolveJournalProfile({ fallbackId: 'unknown_venue' }),
    /journal_profile_identity_unknown:fallback/,
  );
  assert.throws(
    () => buildTargetSelectionPolicy({ fallbackId: 'unknown_venue' }),
    /journal_profile_identity_unknown:fallback/,
  );
  for (const target of ['totally_unknown_venue', 'not a real venue', 'coltalt2027']) {
    assert.throws(
      () => resolveJournalProfile({ target }),
      /journal_profile_target_unknown/,
    );
    const selection = buildTargetSelectionPolicy({ target });
    assert.equal(selection.status, 'target_selection_policy_blocked');
    assert.ok(selection.blockers.includes(
      'target_selection_explicit_identity_unresolved',
    ));
  }
  for (const [target, expectedId] of [
    ['Nature Machine Intelligence', 'nature_machine_intelligence'],
    ['acm transactions on information systems', 'tois'],
    ['SIAM Journal on Computing', 'sicomp'],
    ['robotics science and systems', 'rss'],
    ['Management Science', 'management_science'],
    ['Marketing Science', 'marketing_science'],
    ['Organization Science', 'organization_science'],
  ]) {
    assert.equal(resolveJournalProfile({ target }).id, expectedId);
    const selection = buildTargetSelectionPolicy({ target });
    assert.equal(selection.primaryTarget.journalId, expectedId);
    assert.equal(
      selection.blockers.includes('target_selection_explicit_identity_mismatch'),
      false,
    );
  }
  assert.throws(
    () => resolveJournalProfile({ target: 'STOC/FOCS' }),
    /journal_profile_target_ambiguous:focs,stoc/,
  );
  const ambiguousAlias = buildTargetSelectionPolicy({ target: 'STOC/FOCS' });
  assert.equal(ambiguousAlias.status, 'target_selection_policy_blocked');
  assert.ok(ambiguousAlias.blockers.includes(
    'target_selection_explicit_identity_unresolved',
  ));
});

test('stale registries and caller-declared ready policies cannot restore composite identity', () => {
  const staleComposite = V1_JOURNAL_PROFILES.find(
    (profile) => profile.id === 'colt_alt',
  );
  assert.throws(
    () => buildTargetSelectionPolicy({
      registry: {
        version: 1,
        status: 'journal_conference_registry_ready',
        profiles: [staleComposite],
      },
      hints: ['learning theory'],
    }),
    /journal_profile_identity_ambiguous:registry_profile/,
  );

  const canonicalRegistry = buildJournalConferenceRegistry();
  const forgedProfiles = canonicalRegistry.profiles.map((profile) => (
    profile.id === 'colt'
      ? {
        ...profile,
        policy: {
          ...profile.policy,
          deadlineRouting: {
            ...profile.policy.deadlineRouting,
            deadlineCalendar: [{
              month: 1,
              day: 1,
              label: 'caller-declared deadline',
            }],
          },
        },
      }
      : profile
  ));
  assert.throws(
    () => buildTargetSelectionPolicy({
      registry: {
        ...canonicalRegistry,
        profiles: forgedProfiles,
      },
      target: 'colt',
      createdAt: '2026-07-24T00:00:00.000Z',
    }),
    /journal_profile_snapshot_mismatch:registry_profile:colt/,
  );
  assert.throws(
    () => buildJournalConferenceRegistry({
      profiles: JOURNAL_PROFILE_DATASET.profiles.map((profile) => (
        profile.id === 'colt' ? { ...profile, label: 'forged COLT' } : profile
      )),
    }),
    /journal_profile_snapshot_mismatch:journal_conference_registry_profile:colt/,
  );

  const staleProfile = buildJournalTargetProfile({
    target: 'colt',
    targetSelectionPolicy: {
      status: 'target_selection_policy_ready',
      primaryTarget: {
        label: 'COLT/ALT',
        profile: staleComposite,
      },
    },
  });
  assert.equal(staleProfile.status, 'journal_target_profile_blocked');
  assert.ok(staleProfile.blockers.includes(
    'target_selection_policy_profile_identity_invalid',
  ));

  const altProfile = canonicalRegistry.profiles.find(
    (profile) => profile.id === 'alt',
  );
  const mismatchedProfile = buildJournalTargetProfile({
    target: 'colt',
    targetSelectionPolicy: {
      status: 'target_selection_policy_ready',
      primaryTarget: {
        label: altProfile.label,
        profile: altProfile,
      },
    },
  });
  assert.equal(mismatchedProfile.status, 'journal_target_profile_blocked');
  assert.ok(mismatchedProfile.blockers.includes(
    'target_selection_policy_profile_identity_mismatch',
  ));
});

test('split profiles fail closed on unknown external deadline metadata', () => {
  for (const target of ['colt', 'alt']) {
    const selection = buildTargetSelectionPolicy({
      target,
      createdAt: '2026-07-24T00:00:00.000Z',
    });
    assert.equal(selection.status, 'target_selection_policy_blocked');
    assert.ok(selection.blockers.includes(
      'target_selection_conference_deadline_metadata_required',
    ));
    assert.equal(
      selection.agentDeadlineRoutingDecision.deadlineAssessment.status,
      'conference_deadline_metadata_missing',
    );
    assert.equal(
      selection.agentDeadlineRoutingDecision.status,
      'conference_deadline_metadata_missing',
    );

    const directProfile = buildJournalTargetProfile({ target });
    assert.equal(directProfile.status, 'journal_target_profile_blocked');
    assert.ok(directProfile.blockers.includes('target_selection_policy_required'));
    assert.ok(directProfile.blockers.includes(
      'target_profile_conference_deadline_metadata_required',
    ));
  }
});

test('profile data v2 validation rejects split policy and route drift', () => {
  const withoutAltPolicy = { ...JOURNAL_PROFILE_DATASET.policyDefaults };
  delete withoutAltPolicy.alt;
  const policyDrift = validateJournalProfileDataset({
    profiles: JOURNAL_PROFILE_DATASET.profiles,
    policyDefaults: withoutAltPolicy,
    deadlineRouting:
      JOURNAL_PROFILE_DATASET.computerScienceConferenceDeadlineRouting,
  });
  assert.ok(policyDrift.issues.includes('split_profile_policy_required:alt'));

  const withRetiredPolicy = {
    ...JOURNAL_PROFILE_DATASET.policyDefaults,
    colt_alt: JOURNAL_PROFILE_DATASET.policyDefaults.colt,
  };
  const retiredDrift = validateJournalProfileDataset({
    profiles: JOURNAL_PROFILE_DATASET.profiles,
    policyDefaults: withRetiredPolicy,
    deadlineRouting:
      JOURNAL_PROFILE_DATASET.computerScienceConferenceDeadlineRouting,
  });
  assert.ok(retiredDrift.issues.includes('profile_policy_unknown_profile:colt_alt'));

  const withoutColtRoute = {
    ...JOURNAL_PROFILE_DATASET.computerScienceConferenceDeadlineRouting,
  };
  delete withoutColtRoute.colt;
  const routeDrift = validateJournalProfileDataset({
    profiles: JOURNAL_PROFILE_DATASET.profiles,
    policyDefaults: JOURNAL_PROFILE_DATASET.policyDefaults,
    deadlineRouting: withoutColtRoute,
  });
  assert.ok(routeDrift.issues.includes('split_profile_deadline_route_required:colt'));

  const invalidCalendarRouting = {
    ...JOURNAL_PROFILE_DATASET.computerScienceConferenceDeadlineRouting,
    alt: {
      deadlineCadence: 'annual',
      deadlineCalendar: [{ month: 2, day: 31 }],
      journalFallbackIds: ['jmlr', 'sicomp'],
    },
  };
  const invalidCalendar = validateJournalProfileDataset({
    profiles: JOURNAL_PROFILE_DATASET.profiles,
    policyDefaults: JOURNAL_PROFILE_DATASET.policyDefaults,
    deadlineRouting: invalidCalendarRouting,
  });
  assert.ok(invalidCalendar.issues.includes('deadline_route_calendar_invalid:alt'));

  const invalidCadenceRouting = {
    ...JOURNAL_PROFILE_DATASET.computerScienceConferenceDeadlineRouting,
    colt: {
      deadlineCadence: 'weekly',
      journalFallbackIds: ['jmlr', 'sicomp'],
    },
  };
  const invalidCadence = validateJournalProfileDataset({
    profiles: JOURNAL_PROFILE_DATASET.profiles,
    policyDefaults: JOURNAL_PROFILE_DATASET.policyDefaults,
    deadlineRouting: invalidCadenceRouting,
  });
  assert.ok(invalidCadence.issues.includes('deadline_route_cadence_invalid:colt'));

  const coltPolicy = JOURNAL_PROFILE_DATASET.policyDefaults.colt;
  const altPolicy = JOURNAL_PROFILE_DATASET.policyDefaults.alt;
  for (const field of ['disciplineTags', 'evidenceRequirements', 'deskRejectRules']) {
    assert.notEqual(coltPolicy[field], altPolicy[field]);
    assert.equal(Object.isFrozen(coltPolicy[field]), true);
    assert.equal(Object.isFrozen(altPolicy[field]), true);
  }
});

test('connector families expose the universal operation contract and unsafe defaults are off', () => {
  assert.equal(SUBMISSION_CONNECTOR_FAMILY_REGISTRY.familyCount, 8);
  assert.equal(
    SUBMISSION_CONNECTOR_FAMILY_REGISTRY.prototypeAdapterFamilyCount,
    4,
  );
  assert.equal(SUBMISSION_CONNECTOR_FAMILY_REGISTRY.productionQualifiedFamilyCount, 0);
  for (const family of SUBMISSION_CONNECTOR_FAMILY_REGISTRY.families) {
    assert.equal(verifySubmissionConnectorFamily(family), true);
    assert.equal(family.credentialIsolationRequired, true);
    assert.equal(family.humanFinalReviewRequired, true);
    assert.equal(family.blindCommitRetryPermitted, false);
    assert.equal(family.captchaBypassPermitted, false);
  }
  assert.equal(
    getSubmissionConnectorFamily('playwright-assisted-draft-v1')
      .capabilities.commit,
    false,
  );
});

test('conference portal binding is edition-scoped, evidence-bound and expiring', () => {
  const { target, binding } = portalBinding();
  assert.equal(verifySubmissionPortalBinding(binding, {
    baseTargetProfile: target,
    observedAt: '2026-07-24T00:10:00.000Z',
  }), true);
  assert.equal(verifySubmissionPortalBinding(binding, {
    baseTargetProfile: target,
    observedAt: '2026-09-24T00:10:00.000Z',
  }), false);
  assert.throws(() => buildSubmissionPortalBinding({
    baseTargetProfile: target,
    targetInstanceId: 'ICLR.cc/2027/Conference',
    connectorFamily: 'openreview-api-v2',
  }), /submission_portal_binding_conference_edition_required|submission_portal_binding_input_invalid/);
  assert.equal(binding.productionQualified, false);
  assert.equal(binding.liveCommitAuthorized, false);
});

test('portal binding rejects retired or mutated target snapshots even with a valid record hash', () => {
  const current = getJournalSubmissionTargetProfile('iclr');
  const {
    journalSubmissionTargetProfileHash: _currentHash,
    ...currentPayload
  } = current;
  const retiredPayload = {
    ...currentPayload,
    venueId: 'colt_alt',
    venueLabel: 'COLT/ALT',
  };
  const retired = {
    ...retiredPayload,
    journalSubmissionTargetProfileHash:
      hashRecord('JournalSubmissionTargetProfile', retiredPayload),
  };
  assert.throws(
    () => portalBinding(retired),
    /submission_portal_binding_target_profile_not_current/,
  );

  const forged = {
    ...current,
    venueLabel: 'forged current label',
  };
  assert.throws(
    () => portalBinding(forged),
    /submission_portal_binding_input_invalid/,
  );
});

test('canonical envelope keeps unknown declarations explicit and gates review and commit', () => {
  const { binding } = portalBinding();
  const draftEnvelope = envelope(binding);
  assert.equal(verifySubmissionEnvelope(draftEnvelope, {
    requestHash: sha('7'),
    portalBindingHash: binding.submissionPortalBindingHash,
  }), true);
  assert.deepEqual(draftEnvelope.unknownDeclarationIds, ['conflict_of_interest']);
  assert.equal(buildSubmissionEnvelopePreflight({
    envelope: draftEnvelope,
    portalBinding: binding,
    stage: 'draft',
    observedAt: '2026-07-24T00:10:00.000Z',
  }).status, 'submission_envelope_preflight_draft_ready');
  assert.ok(buildSubmissionEnvelopePreflight({
    envelope: draftEnvelope,
    portalBinding: binding,
    stage: 'review',
    observedAt: '2026-07-24T00:10:00.000Z',
  }).blockers.includes('submission_declarations_unresolved'));

  const reviewedEnvelope = envelope(binding, 'no');
  assert.equal(buildSubmissionEnvelopePreflight({
    envelope: reviewedEnvelope,
    portalBinding: binding,
    stage: 'commit',
    observedAt: '2026-07-24T00:10:00.000Z',
    commitAuthorizationHash: sha('9'),
  }).status, 'submission_envelope_preflight_commit_ready');
  assert.ok(buildSubmissionEnvelopePreflight({
    envelope: reviewedEnvelope,
    portalBinding: binding,
    stage: 'commit',
    observedAt: '2026-07-24T00:10:00.000Z',
  }).blockers.includes('submission_commit_authorization_missing'));

  assert.throws(() => buildSubmissionEnvelope({
    ...draftEnvelope,
    portalBindingHash: binding.submissionPortalBindingHash,
    dynamicAnswers: [{
      fieldId: 'submission_type',
      schemaFingerprintHash: sha('2'),
      valueType: 'invented_type',
      valueStatus: 'unknown',
      value: null,
    }],
  }), /submission_envelope_dynamic_answer_invalid/);
});

test('connector router resolves by verified binding and cannot silently promote a prototype', () => {
  const { target, binding } = portalBinding();
  const router = createSubmissionConnectorRouter({ connectors: [connector()] });
  assert.equal(router.resolve({
    baseTargetProfile: target,
    portalBinding: binding,
    operation: 'preview',
    observedAt: '2026-07-24T00:10:00.000Z',
  }).connectorId, 'openreview-fixture');
  assert.throws(() => router.resolve({
    baseTargetProfile: target,
    portalBinding: binding,
    operation: 'preview',
    observedAt: '2026-07-24T00:10:00.000Z',
    requireProductionEligible: true,
  }), /submission_connector_route_not_production_eligible/);
  assert.throws(() => router.resolve({
    baseTargetProfile: target,
    portalBinding: binding,
    operation: 'uploadAssets',
    observedAt: '2026-07-24T00:10:00.000Z',
  }), /submission_connector_route_operation_disabled/);
});
