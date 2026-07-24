import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOURNAL_SUBMISSION_TARGET_REGISTRY,
  buildJournalSubmissionTargetRegistry,
  getJournalSubmissionTargetProfile,
} from '../../paper-domain/submission/journal-submission-target-registry.mjs';
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

const sha = (character) => `sha256:${character.repeat(64)}`;

function portalBinding() {
  const target = getJournalSubmissionTargetProfile('iclr');
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

test('target registry covers exactly 97 stable venue identities without fallback', () => {
  const registry = JOURNAL_SUBMISSION_TARGET_REGISTRY;
  assert.equal(registry.targetProfileCount, 97);
  assert.equal(registry.conferenceTargetCount, 37);
  assert.equal(registry.journalTargetCount, 60);
  assert.equal(registry.connectorFamilyPrototypeAvailableCount, 96);
  assert.equal(registry.conferenceConnectorFamilyPrototypeAvailableCount, 36);
  assert.equal(registry.journalConnectorFamilyPrototypeAvailableCount, 60);
  assert.equal(registry.prototypeAdapterPresentCount, 4);
  assert.equal(registry.discoveryRequiredCount, 97);
  assert.equal(registry.silentFallbackPermitted, false);
  assert.equal(new Set(registry.targets.map((target) => target.venueId)).size, 97);
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
