import assert from 'node:assert/strict';
import fs from 'node:fs';
import inspector from 'node:inspector';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAutonomousSubmissionReceipt,
  createAutonomousSubmissionRequestVerifier,
  verifyAutonomousSubmissionReceipt,
  verifyLegacyAutonomousSubmissionReceipt,
  verifyAutonomousSubmissionRequest,
} from '../../paper-domain/automation/autonomous-submission-contract.mjs';
import {
  autonomousSubmissionOutboxMessageId,
  autonomousSubmissionSideEffectReservationHash,
  buildAutonomousSubmissionAuthoritativeNotFoundReceipt,
  buildAutonomousSubmissionDeliveryStateReceipt,
  buildAutonomousSubmissionDispatchPermit,
  buildAutonomousSubmissionPortalLookupOutcome,
  verifyAutonomousSubmissionAuthoritativeNotFoundReceipt,
  verifyAutonomousSubmissionDeliveryStateReceipt,
  verifyAutonomousSubmissionDispatchPermit,
  verifyAutonomousSubmissionPortalLookupOutcome,
} from '../../paper-domain/automation/autonomous-submission-delivery-contract.mjs';
import {
  buildAutonomousLiveSubmissionAuthorizationSubject,
} from '../../paper-domain/submission/autonomous-live-submission-authorization-contract.mjs';
import {
  buildAutonomousVenueProfile,
  buildAutonomousVenueProfileRegistry,
  selectAutonomousVenueProfile,
  verifyAutonomousVenueProfile,
  verifyAutonomousVenueProfileRegistry,
  verifyAutonomousVenueProfileSelection,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  composePinnedAutonomousSubmissionRequestVerifier,
} from '../../paper-composition/automation/autonomous-submission-request-verifier-composition.mjs';
import {
  buildAutonomousSubmissionPortalConfiguration,
} from '../../paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs';
import {
  buildSignedAutonomousVenueProfileRegistryConfiguration,
} from '../../paper-adapters/automation/autonomous-venue-profile-registry-reader.mjs';
import {
  buildSignedAutonomousSubmissionMetadataProfileConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-metadata-profile-reader.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import {
  FIXED_TIME,
  digest,
  genericManuscriptReleaseFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import {
  productionResearchClosureFixture,
  qualificationIndependentEvidenceVerifier,
  qualificationSignatureVerifier,
} from './support/autonomous-research-generalization-closure-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('AutonomousSubmissionOwnerCoverageTest', { label });
const SUBMISSION_FIXTURES = new Map();
const PROOF_FIELDS = Object.freeze([
  'trustedAutonomousManuscriptRenderReceiptHash',
  'evidenceBoundManuscriptIrHash',
  'manuscriptIrFileHash',
  'renderedManuscriptHash',
  'agentExecutionReceiptHash',
  'isolatedAgentMergeReceiptHash',
  'agentAuthoredSourceDraftHash',
  'agentAuthoredSourceDraftFileHash',
  'agentWorkspacePostimageBindingHash',
]);

function submissionFixture({ portalConfigurationHash = H('portal-configuration') } = {}) {
  if (SUBMISSION_FIXTURES.has(portalConfigurationHash)) {
    return SUBMISSION_FIXTURES.get(portalConfigurationHash);
  }
  const fixture = productionResearchClosureFixture({
    paperId: 'submission-owner-paper',
    campaignId: 'submission-owner-campaign',
    campaignPlanHash: H('campaign-plan'),
    portalConfigurationHash,
  });
  fixture.cleanup();
  const selected = Object.freeze({
    authority: fixture.campaignReleaseAuthority,
    inspection: fixture.qualificationInspection,
    manuscript: fixture.manuscript,
    request: fixture.submissionRequest,
    venueComplianceReceipt: fixture.venueComplianceReceipt,
  });
  SUBMISSION_FIXTURES.set(portalConfigurationHash, selected);
  return selected;
}

function trustVerifier(overrides = {}) {
  return createAutonomousSubmissionRequestVerifier({
    verifyCurrentCampaignReleaseAuthority: () => true,
    verifyQualificationAuthority: () => true,
    verifyVenueComplianceAuthority: () => true,
    verifyPortalConfigurationAuthority: () => true,
    verifyQualificationSignature: qualificationSignatureVerifier,
    verifyIndependentQualificationEvidence:
      qualificationIndependentEvidenceVerifier,
    ...overrides,
  });
}

function memoizedTrustVerifier(overrides = {}) {
  const verifier = trustVerifier(overrides);
  const decisions = new WeakMap();
  return Object.freeze({
    ...verifier,
    verify(request) {
      if (request && decisions.has(request)) return decisions.get(request);
      const result = verifier.verify(request);
      if (request && typeof request === 'object') decisions.set(request, result);
      return result;
    },
  });
}

function mutated(value, propertyPath, replacement = H(`mutated:${propertyPath}`)) {
  const copy = structuredClone(value);
  const segments = propertyPath.split('.');
  const key = segments.pop();
  let owner = copy;
  for (const segment of segments) owner = owner[segment];
  owner[key] = replacement;
  return copy;
}

function humanAuthorizedDispatchRequest(request, {
  portalId,
  serviceIdentityHash,
  portalAccountIdentityHash,
  portalTrustDomainIdentityHash,
} = {}) {
  const portalDescriptorHash = H('dispatch-portal-descriptor');
  const subject = buildAutonomousLiveSubmissionAuthorizationSubject({
    campaignId: request.campaignId,
    paperId: request.paperId,
    immutableCampaignPackageOutputHash: request.immutableCampaignPackageOutputHash,
    campaignReleaseBundleHash: request.campaignReleaseBundleHash,
    qualificationReceiptHash: request.qualificationReceiptHash,
    researchClosureReceiptHash: request.researchClosureReceiptHash,
    venueComplianceReceiptHash: request.venueComplianceReceiptHash,
    submissionMetadataReceiptHash: request.submissionMetadataReceiptHash,
    venueProfileSelectionHash: request.venueProfileSelectionHash,
    venueId: request.venueId,
    submissionPortalProfileId: request.submissionPortalProfileId,
    portalId,
    portalConfigurationHash: request.portalConfigurationHash,
    portalDescriptorHash,
    serviceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
  });
  const authorizationDocument = Object.freeze({
    version: 1,
    kind: 'LiveSubmissionAuthorization',
    paperId: request.paperId,
    taskKey: request.campaignId,
    allowLiveExternalAction: true,
    environment: 'production',
    portalAction: 'submit_manuscript',
    singleUse: true,
    nonce: 'submission-owner-human-permit-0001',
    provider: portalId,
    accountId: portalAccountIdentityHash,
    authorizationSubjectHash: subject.liveSubmissionAuthorizationSubjectHash,
    signedAt: '2026-07-19T00:01:00.000Z',
    validFrom: '2026-07-19T00:01:00.000Z',
    expiresAt: '2026-07-19T01:00:00.000Z',
    responseDueAt: '2026-07-19T00:30:00.000Z',
    signatures: Object.freeze([
      Object.freeze({
        keyId: 'submission-owner-operator',
        role: 'submission_operator',
        algorithm: 'ed25519',
        value: 'fixture',
      }),
      Object.freeze({
        keyId: 'submission-owner-executor',
        role: 'live_executor_authorizer',
        algorithm: 'ed25519',
        value: 'fixture',
      }),
    ]),
  });
  const signatureVerification = Object.freeze({
    status: 'authority_signatures_verified',
    cryptographicSignaturesVerified: true,
    requiredRoles: Object.freeze(['submission_operator', 'live_executor_authorizer']),
    requiredSignatureCount: 2,
    verifiedSignatures: Object.freeze([]),
    verifiedRoles: Object.freeze(['live_executor_authorizer', 'submission_operator']),
    verifiedSubjectIds: Object.freeze([
      'submission-owner-executor',
      'submission-owner-operator',
    ]),
    blockers: Object.freeze([]),
  });
  const timeWindow = Object.freeze({
    valid: true,
    signedAt: authorizationDocument.signedAt,
    validFrom: authorizationDocument.validFrom,
    expiresAt: authorizationDocument.expiresAt,
    blockers: Object.freeze([]),
  });
  const authorizationPayload = Object.freeze({
    version: 2,
    kind: 'LiveSubmissionAuthorizationReceipt',
    authorizationMode: 'autonomous_submission_handoff',
    paperId: request.paperId,
    taskKey: request.campaignId,
    status: 'live_submission_authorization_verified',
    liveExternalActionAuthorized: true,
    cryptographicSignaturesVerified: true,
    authorizationPath: 'fixture/LIVE_SUBMISSION_AUTHORIZATION.json',
    authorizationSubject: subject,
    authorizationSubjectHash: subject.liveSubmissionAuthorizationSubjectHash,
    authorizationDocument,
    authorizationDocumentHash: hashRecord(
      'LiveSubmissionAuthorizationDocument', authorizationDocument,
    ),
    provider: portalId,
    accountId: portalAccountIdentityHash,
    portalRoute: request.submissionPortalProfileId,
    portalAction: 'submit_manuscript',
    environment: 'production',
    nonce: authorizationDocument.nonce,
    singleUse: true,
    signedAt: authorizationDocument.signedAt,
    validFrom: authorizationDocument.validFrom,
    expiresAt: authorizationDocument.expiresAt,
    authorizerSubjectIds: signatureVerification.verifiedSubjectIds,
    signatureVerification,
    timeWindow,
    consumed: false,
    responseDueAt: authorizationDocument.responseDueAt,
    blockers: Object.freeze([]),
    safety: Object.freeze({
      humanReviewRequired: true,
      dualControlRequired: true,
      singleUseAuthorization: true,
      authorizationLifetimeHoursMaximum: 24,
      separatedDutiesEnforced: true,
      grantsExecutionInsideOverlay: false,
      externalActionPerformed: false,
    }),
  });
  const humanAuthorizationReceipt = Object.freeze({
    ...authorizationPayload,
    liveSubmissionAuthorizationReceiptHash: hashRecord(
      'LiveSubmissionAuthorizationReceipt', authorizationPayload,
    ),
  });
  const payload = { ...request };
  delete payload.requestHash;
  Object.assign(payload, {
    version: 7,
    portalId,
    portalDescriptorHash,
    portalServiceIdentityHash: serviceIdentityHash,
    portalAccountIdentityHash,
    portalTrustDomainIdentityHash,
    humanAuthorizationReceiptHash:
      humanAuthorizationReceipt.liveSubmissionAuthorizationReceiptHash,
    humanAuthorizationSubjectHash: subject.liveSubmissionAuthorizationSubjectHash,
    humanAuthorizationNonce: humanAuthorizationReceipt.nonce,
    humanAuthorizationExpiresAt: humanAuthorizationReceipt.expiresAt,
    humanAuthorizationReceipt,
    humanApprovalPerformed: true,
  });
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('AutonomousSubmissionRequest', payload),
  });
}

async function invokeComposedTrustFacets(verifier, inputs) {
  const globalSlot = '__heptaSubmissionOwnerCompositionProbe';
  globalThis[globalSlot] = { verifier, inputs };
  const session = new inspector.Session();
  const post = (method, parameters = {}) => new Promise((resolve, reject) => {
    session.post(method, parameters, (error, result) => (
      error ? reject(error) : resolve(result)
    ));
  });
  session.connect();
  try {
    await post('Runtime.enable');
    const evaluated = await post('Runtime.evaluate', {
      expression: `globalThis.${globalSlot}.verifier.verify`,
    });
    const verifierProperties = await post('Runtime.getProperties', {
      objectId: evaluated.result.objectId,
      ownProperties: false,
    });
    const scopes = verifierProperties.internalProperties.find((property) => (
      property.name === '[[Scopes]]'
    ));
    assert.ok(scopes?.value?.objectId);
    const scopeList = await post('Runtime.getProperties', {
      objectId: scopes.value.objectId,
      ownProperties: true,
    });
    const closure = scopeList.result.find((property) => (
      property.value?.description === 'Closure (createAutonomousSubmissionRequestVerifier)'
    ));
    assert.ok(closure?.value?.objectId);
    const closureProperties = await post('Runtime.getProperties', {
      objectId: closure.value.objectId,
      ownProperties: true,
    });
    const results = {};
    for (const name of Object.keys(inputs)) {
      const callback = closureProperties.result.find((property) => property.name === name);
      assert.ok(callback?.value?.objectId, name);
      const called = await post('Runtime.callFunctionOn', {
        objectId: callback.value.objectId,
        functionDeclaration: `function(name) {
          return this(globalThis.${globalSlot}.inputs[name]);
        }`,
        arguments: [{ value: name }],
        returnByValue: true,
        awaitPromise: true,
      });
      assert.equal(called.exceptionDetails, undefined, name);
      results[name] = called.result.value;
    }
    return results;
  } finally {
    delete globalThis[globalSlot];
    session.disconnect();
  }
}

test('submission request owner rejects independently mutated recursive and top-level bindings', () => {
  const fixture = submissionFixture();
  const verifier = trustVerifier();
  assert.equal(verifier.verify(fixture.request), true);
  assert.equal(verifyAutonomousSubmissionRequest(fixture.request), false);

  for (const propertyPath of [
    'version',
    'kind',
    'campaignReleaseAuthority.status',
    'campaignReleaseAuthority.campaignId',
    'campaignReleaseAuthority.releaseBundle.campaignReleaseBundleHash',
    'campaignReleaseAuthority.releaseBundle.packageOutput.immutableCampaignPackageOutputHash',
    'autonomousResearchReleaseBinding.autonomousResearchReleaseBindingHash',
    'venueProfileSelection.autonomousVenueProfileSelectionReceiptHash',
    'venueProfileSelection.rankingReceipt.autonomousVenueProfileRankingReceiptHash',
    'qualificationInspection.ready',
    'immutableCampaignPackageOutputHash',
    'sourceSnapshotHash',
    'sourceTreeManifestHash',
    'researchEvidenceCapsuleManifestHash',
    'qualificationReceiptHash',
    'venueComplianceReceiptHash',
    'submissionMetadataReceiptHash',
    'submissionMetadataAuthorityConfigurationHash',
    'renderedSourceHash',
    'compiledPdfHash',
    'independentRebuiltPdfHash',
    'pageCount',
    'venueProfileHash',
    'submissionPortalProfileId',
    'idempotencyKey',
    'qualificationScope',
    'manuscriptProductionMode',
    ...PROOF_FIELDS,
    'requestHash',
  ]) {
    assert.equal(verifier.verify(mutated(fixture.request, propertyPath)), false, propertyPath);
  }

  const callbacks = [
    'verifyCurrentCampaignReleaseAuthority',
    'verifyVenueComplianceAuthority',
    'verifyQualificationAuthority',
    'verifyPortalConfigurationAuthority',
  ];
  for (const callback of callbacks) {
    assert.equal(trustVerifier({ [callback]: () => false }).verify(fixture.request), false);
  }
  assert.equal(trustVerifier({
    verifyCurrentCampaignReleaseAuthority() { throw new Error('authority unavailable'); },
  }).verify(fixture.request), false);
  for (const callback of callbacks) {
    assert.throws(
      () => createAutonomousSubmissionRequestVerifier({
        verifyCurrentCampaignReleaseAuthority: () => true,
        verifyVenueComplianceAuthority: () => true,
        verifyQualificationAuthority: () => true,
        verifyPortalConfigurationAuthority: () => true,
        [callback]: null,
      }),
      /autonomous_submission_request_trust_verifier_required/,
      callback,
    );
  }
});

test('submission receipt and delivery owner cover valid state transitions and invalid edges', () => {
  const fixture = submissionFixture();
  const verifier = memoizedTrustVerifier();
  const completedReceiptVerifier = Object.freeze({
    kind: 'AutonomousSubmissionCompletedReceiptVerifier',
    verify: () => true,
  });
  const receipt = buildAutonomousSubmissionReceipt({
    request: fixture.request,
    requestVerifier: verifier,
    portalSubmissionId: 'submission-owner-id',
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    submissionArtifactManifestHash: H('artifact-manifest'),
    signatureHash: H('signature'),
    signatureVerificationReceiptHash: H('signature-verification'),
    submittedAt: FIXED_TIME,
  });
  assert.equal(verifyLegacyAutonomousSubmissionReceipt(receipt, {
    request: fixture.request,
    requestVerifier: verifier,
  }), true);
  assert.equal(verifyAutonomousSubmissionReceipt(receipt, {
    request: fixture.request,
    requestVerifier: verifier,
    requireCryptographicAuthority: true,
  }), false);
  assert.equal(verifyAutonomousSubmissionReceipt({ version: 6 }, {
    request: fixture.request,
    requestVerifier: verifier,
  }), false);
  assert.equal(verifyAutonomousSubmissionReceipt({ version: 6 }, {
    request: fixture.request,
    requestVerifier: verifier,
    completedReceiptVerifier,
  }), true);

  assert.match(
    autonomousSubmissionOutboxMessageId(fixture.request, { requestVerifier: verifier }),
    /^autonomous-submission:sha256:/,
  );
  assert.match(
    autonomousSubmissionSideEffectReservationHash(fixture.request, {
      requestVerifier: verifier,
    }),
    /^sha256:/,
  );
  assert.throws(() => autonomousSubmissionOutboxMessageId(fixture.request),
    /autonomous_submission_delivery_request_invalid/);
  assert.throws(() => autonomousSubmissionSideEffectReservationHash(fixture.request),
    /autonomous_submission_delivery_request_invalid/);

  const lookupInput = {
    request: fixture.request,
    portalId: 'submission-owner-portal',
    portalConfigurationHash: fixture.request.portalConfigurationHash,
    serviceIdentityHash: H('portal-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
  };
  const notFound = buildAutonomousSubmissionAuthoritativeNotFoundReceipt(lookupInput);
  assert.equal(verifyAutonomousSubmissionAuthoritativeNotFoundReceipt(notFound, {
    request: fixture.request,
    portalId: lookupInput.portalId,
  }), true);
  assert.equal(verifyAutonomousSubmissionAuthoritativeNotFoundReceipt(
    mutated(notFound, 'portalId', 'wrong-portal'),
    { request: fixture.request, portalId: lookupInput.portalId },
  ), false);
  const lookup = buildAutonomousSubmissionPortalLookupOutcome({
    ...lookupInput,
    observedAt: FIXED_TIME,
  });
  assert.equal(verifyAutonomousSubmissionPortalLookupOutcome(lookup, {
    request: fixture.request,
    portalId: lookupInput.portalId,
  }), true);
  assert.equal(verifyAutonomousSubmissionPortalLookupOutcome(
    mutated(lookup, 'observedAt', 'not-an-instant'),
    { request: fixture.request, portalId: lookupInput.portalId },
  ), false);
  for (const property of [
    'request.requestHash',
    'request.idempotencyKey',
    'portalId',
    'portalConfigurationHash',
    'serviceIdentityHash',
    'portalAccountIdentityHash',
    'portalTrustDomainIdentityHash',
  ]) {
    const input = structuredClone(lookupInput);
    const [ownerKey, key] = property.split('.');
    if (key) input[ownerKey][key] = 'invalid';
    else input[property] = property === 'portalId' ? '' : 'invalid';
    assert.throws(
      () => buildAutonomousSubmissionAuthoritativeNotFoundReceipt(input),
      /autonomous_submission_authoritative_not_found_receipt_invalid/,
      property,
    );
  }

  const dispatchRequest = humanAuthorizedDispatchRequest(fixture.request, lookupInput);
  const dispatchNotFound = buildAutonomousSubmissionAuthoritativeNotFoundReceipt({
    ...lookupInput,
    request: dispatchRequest,
  });
  const initialPermit = buildAutonomousSubmissionDispatchPermit({
    request: dispatchRequest,
    portalId: lookupInput.portalId,
    attempt: 1,
    previousState: 'prepared',
    previousStateReceiptHash: H('prepared-state'),
    dispatchStateReceiptHash: H('dispatching-state'),
    resolution: 'initial-dispatch',
  });
  assert.equal(verifyAutonomousSubmissionDispatchPermit(initialPermit, {
    request: dispatchRequest,
    portalId: lookupInput.portalId,
  }), true);
  const redrivePermit = buildAutonomousSubmissionDispatchPermit({
    request: dispatchRequest,
    portalId: lookupInput.portalId,
    attempt: 2,
    previousState: 'uncertain',
    previousStateReceiptHash: H('uncertain-state'),
    dispatchStateReceiptHash: H('redrive-state'),
    resolution: 'remote-authoritative-not-found-redrive',
    authoritativeNotFoundReceiptHash:
      dispatchNotFound.autonomousSubmissionAuthoritativeNotFoundReceiptHash,
    onlineMutationSideEffectPermitHash: H('online-side-effect-permit'),
  });
  assert.equal(verifyAutonomousSubmissionDispatchPermit(redrivePermit, {
    request: dispatchRequest,
    portalId: lookupInput.portalId,
  }), true);
  for (const override of [
    { attempt: 0 },
    { previousStateReceiptHash: 'invalid' },
    { dispatchStateReceiptHash: 'invalid' },
    { onlineMutationSideEffectPermitHash: 'invalid' },
    { previousState: 'completed' },
    { resolution: 'remote-authoritative-not-found-redrive' },
  ]) assert.throws(() => buildAutonomousSubmissionDispatchPermit({
    request: dispatchRequest,
    portalId: lookupInput.portalId,
    attempt: 1,
    previousState: 'prepared',
    previousStateReceiptHash: H('prepared-state'),
    dispatchStateReceiptHash: H('dispatching-state'),
    resolution: 'initial-dispatch',
    ...override,
  }), /autonomous_submission_dispatch_permit_invalid/);

  const stateCases = [
    { state: 'prepared', attempt: 0, resolution: 'local-intent-persisted' },
    {
      state: 'dispatching', attempt: 1, resolution: 'initial-dispatch',
      previousStateReceiptHash: H('prepared-state'),
    },
    {
      state: 'completed', attempt: 1, resolution: 'remote-confirmed-completed',
      previousStateReceiptHash: H('dispatching-state'),
      submissionReceipt: { version: 6 },
    },
    {
      state: 'explicit_failure', attempt: 1,
      resolution: 'remote-confirmed-explicit-failure',
      previousStateReceiptHash: H('dispatching-state'),
      failure: { code: 'remote-rejected', httpStatus: 422 },
    },
    {
      state: 'uncertain', attempt: 1, resolution: 'remote-outcome-uncertain',
      previousStateReceiptHash: H('dispatching-state'),
      failure: { code: 'transport-timeout', httpStatus: null },
    },
  ];
  for (const stateCase of stateCases) {
    const stateReceipt = buildAutonomousSubmissionDeliveryStateReceipt({
      request: fixture.request,
      portalId: lookupInput.portalId,
      recordedAt: FIXED_TIME,
      requestVerifier: verifier,
      completedReceiptVerifier,
      ...stateCase,
    });
    assert.equal(verifyAutonomousSubmissionDeliveryStateReceipt(stateReceipt, {
      request: fixture.request,
      requestVerifier: verifier,
      completedReceiptVerifier,
    }), true, stateCase.state);
    assert.equal(verifyAutonomousSubmissionDeliveryStateReceipt(
      mutated(stateReceipt, 'recordedAt', 'invalid'),
      { request: fixture.request, requestVerifier: verifier, completedReceiptVerifier },
    ), false, stateCase.state);
  }
  for (const failure of [
    { code: '', httpStatus: null },
    { code: 'bad-status', httpStatus: 99 },
    { code: 'bad-status', httpStatus: 600 },
  ]) assert.throws(() => buildAutonomousSubmissionDeliveryStateReceipt({
    request: fixture.request,
    portalId: lookupInput.portalId,
    state: 'uncertain',
    attempt: 1,
    resolution: 'remote-outcome-uncertain',
    previousStateReceiptHash: H('dispatching-state'),
    failure,
    recordedAt: FIXED_TIME,
    requestVerifier: verifier,
  }), /autonomous_submission_delivery_failure_invalid/);
});

test('venue owner rejects malformed profile, registry, and selection fields independently', () => {
  const validProfileInput = {
    venueId: 'submission-owner-venue',
    displayName: 'Submission Owner Venue',
    acceptedPaperTypes: ['research_article'],
    protocolFamilies: ['ml_algorithm_benchmark'],
    documentClass: 'article',
    bibliographyStyle: 'plain',
    citationStyle: 'numeric',
    maximumPages: 20,
    requiredMetadata: ['title', 'abstract'],
    submissionPortalProfileId: 'submission-owner-portal',
    externalSubmissionEnabled: true,
    profileAuthorityReceiptHash: H('profile-authority'),
  };
  const profile = buildAutonomousVenueProfile(validProfileInput);
  assert.equal(verifyAutonomousVenueProfile(profile), true);
  for (const override of [
    { venueId: '' },
    { displayName: '' },
    { acceptedPaperTypes: [] },
    { acceptedPaperTypes: ['research_article', 'research_article'] },
    { protocolFamilies: [] },
    { documentClass: '1bad' },
    { bibliographyStyle: '1bad' },
    { citationStyle: 'bad value' },
    { maximumPages: 0 },
    { maximumPages: 1_001 },
    { requiredMetadata: [] },
    { submissionPortalProfileId: null },
    { profileAuthorityReceiptHash: 'invalid' },
  ]) assert.throws(() => buildAutonomousVenueProfile({
    ...validProfileInput,
    ...override,
  }), /autonomous_venue_profile_invalid/);

  for (const override of [
    { scopeTerms: [] },
    { scopeTerms: ['same', 'same'] },
    { scopeTerms: ['machine learning'], minimumScopeMatchCount: 0 },
    { scopeTerms: ['machine learning'], minimumScopeMatchCount: 2 },
  ]) assert.throws(() => buildAutonomousVenueProfile({
    ...validProfileInput,
    ...override,
  }), /autonomous_venue_profile_invalid/);
  assert.equal(verifyAutonomousVenueProfile({ ...profile, unexpected: true }), false);
  assert.equal(verifyAutonomousVenueProfile(mutated(profile, 'venueId', '')), false);

  const registry = buildAutonomousVenueProfileRegistry({
    registryId: 'submission-owner-registry',
    profiles: [profile],
  });
  assert.equal(verifyAutonomousVenueProfileRegistry(registry), true);
  assert.throws(() => buildAutonomousVenueProfileRegistry({
    registryId: '', profiles: [profile],
  }), /autonomous_venue_profile_registry_invalid/);
  assert.throws(() => buildAutonomousVenueProfileRegistry({
    registryId: 'empty', profiles: [],
  }), /autonomous_venue_profile_registry_invalid/);
  assert.throws(() => buildAutonomousVenueProfileRegistry({
    registryId: 'duplicate', profiles: [profile, profile],
  }), /autonomous_venue_profile_registry_duplicate/);
  assert.equal(verifyAutonomousVenueProfileRegistry(mutated(
    registry, 'profileCount', 2,
  )), false);

  const selection = selectAutonomousVenueProfile({
    registry,
    paperId: 'submission-owner-paper',
    protocolFamily: 'ml_algorithm_benchmark',
    selectedAt: FIXED_TIME,
  });
  assert.equal(verifyAutonomousVenueProfileSelection(selection, { registry }), true);
  for (const propertyPath of [
    'kind', 'status', 'machineSelected', 'humanApprovalPerformed',
    'venueId', 'venueProfileHash', 'autonomousVenueProfileSelectionReceiptHash',
  ]) assert.equal(verifyAutonomousVenueProfileSelection(
    mutated(selection, propertyPath),
    { registry },
  ), false, propertyPath);
  assert.equal(verifyAutonomousVenueProfileSelection(selection, {
    registry: mutated(registry, 'autonomousVenueProfileRegistryHash'),
  }), false);
  assert.throws(() => selectAutonomousVenueProfile({
    registry, paperId: '', protocolFamily: 'ml_algorithm_benchmark',
  }), /autonomous_venue_profile_selection_input_invalid/);
  assert.throws(() => selectAutonomousVenueProfile({
    registry, paperId: 'paper', protocolFamily: 'unsupported',
  }), /autonomous_venue_profile_not_covered/);

  const strong = genericManuscriptReleaseFixture({
    paperId: 'submission-owner-strong-paper',
    campaignId: 'submission-owner-strong-campaign',
    campaignPlanHash: digest('submission-owner-strong-plan'),
    externalSubmission: true,
  }).venueProfileSelection;
  assert.equal(verifyAutonomousVenueProfileSelection(strong, {
    authorityObservedAt: FIXED_TIME,
  }), true);
  assert.equal(verifyAutonomousVenueProfileSelection(strong, {
    authorityObservedAt: FIXED_TIME,
    expectedVenueAuthorityConfigurationHash: H('wrong-venue-configuration'),
  }), false);
  assert.equal(verifyAutonomousVenueProfileSelection(strong, {
    authorityObservedAt: FIXED_TIME,
    expectedSubmissionMetadataAuthorityConfigurationHash:
      H('wrong-metadata-configuration'),
  }), false);
});

test('pinned submission verifier composition fails closed without external trust state', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-submission-owner-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root: runtimeRoot, runtimeRoot });
  store.close();
  assert.throws(() => composePinnedAutonomousSubmissionRequestVerifier({
    runtimeRoot,
  }), /autonomous_submission_request_verifier_scope_required/);
  assert.throws(() => composePinnedAutonomousSubmissionRequestVerifier({
    root: runtimeRoot,
  }), /autonomous_submission_request_verifier_scope_required/);

  const verifier = composePinnedAutonomousSubmissionRequestVerifier({
    root: runtimeRoot,
    runtimeRoot,
    clock: { now: () => new Date(FIXED_TIME) },
    environment: {},
  });
  assert.equal(verifier.kind, 'AutonomousSubmissionRequestVerifier');
  assert.equal(verifier.verify(submissionFixture().request), false);

  const portalConfiguration = buildAutonomousSubmissionPortalConfiguration({
    portalId: 'submission-owner-portal',
    endpoint: 'https://submission-owner.example.test/submit',
    serviceIdentityHash: H('portal-service'),
    portalAccountIdentityHash: H('portal-account'),
    portalTrustDomainIdentityHash: H('portal-trust-domain'),
    tokenEnvironmentVariable: 'SUBMISSION_OWNER_PORTAL_TOKEN',
  });
  const trustedFixture = submissionFixture({
    portalConfigurationHash: portalConfiguration.configurationHash,
  });
  const selection = trustedFixture.manuscript.venueProfileSelection;
  const venueProof = selection.registryAuthorityProof;
  const metadataProof = selection.submissionMetadataAuthorityProof;
  const venueConfiguration = buildSignedAutonomousVenueProfileRegistryConfiguration({
    registry: selection.registry,
    templateAssets: selection.venueTemplateAssetBundle.assets,
    trustStore: venueProof.trustStore,
    authorityEnvelope: venueProof.authorityEnvelope,
    expectedKeyIds: venueProof.expectedKeyIds,
    maximumLifetimeMs: venueProof.maximumLifetimeMs,
    observedAt: FIXED_TIME,
  });
  const metadataConfiguration =
    buildSignedAutonomousSubmissionMetadataProfileConfiguration({
      profile: selection.submissionMetadataProfile,
      trustStore: metadataProof.trustStore,
      authorityEnvelope: metadataProof.authorityEnvelope,
      expectedKeyIds: metadataProof.expectedKeyIds,
      maximumLifetimeMs: metadataProof.maximumLifetimeMs,
      observedAt: FIXED_TIME,
    });
  const venueConfigurationPath = path.join(runtimeRoot, 'venue-configuration.json');
  const metadataConfigurationPath = path.join(runtimeRoot, 'metadata-configuration.json');
  const portalConfigurationPath = path.join(runtimeRoot, 'portal-configuration.json');
  fs.writeFileSync(venueConfigurationPath, JSON.stringify(venueConfiguration), { mode: 0o600 });
  fs.writeFileSync(metadataConfigurationPath, JSON.stringify(metadataConfiguration), {
    mode: 0o600,
  });
  fs.writeFileSync(portalConfigurationPath, JSON.stringify(portalConfiguration), {
    mode: 0o600,
  });
  const configuredVerifier = composePinnedAutonomousSubmissionRequestVerifier({
    root: runtimeRoot,
    runtimeRoot,
    clock: { now: () => new Date(FIXED_TIME) },
    environment: {
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG: portalConfigurationPath,
      HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG: venueConfigurationPath,
      HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH: venueConfiguration.configurationHash,
      HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG: metadataConfigurationPath,
      HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH:
        metadataConfiguration.configurationHash,
    },
    allowPortalCredential: true,
  });
  assert.equal(configuredVerifier.kind, 'AutonomousSubmissionRequestVerifier');
  assert.equal(configuredVerifier.verify(trustedFixture.request), false);
  const trustFacetResults = await invokeComposedTrustFacets(configuredVerifier, {
    verifyCurrentCampaignReleaseAuthority: {
      campaignReleaseAuthority: trustedFixture.authority,
      request: trustedFixture.request,
    },
    verifyVenueComplianceAuthority: {
      venueComplianceReceipt: trustedFixture.venueComplianceReceipt,
      venueProfileSelection: selection,
      campaignReleaseAuthority: trustedFixture.authority,
      autonomousResearchReleaseBinding:
        trustedFixture.request.autonomousResearchReleaseBinding,
      request: trustedFixture.request,
    },
    verifyQualificationAuthority: {
      qualificationInspection: trustedFixture.inspection,
      qualificationReceipt: trustedFixture.inspection.qualificationReceipt,
      campaignReleaseAuthority: trustedFixture.authority,
      autonomousResearchReleaseBinding:
        trustedFixture.request.autonomousResearchReleaseBinding,
      request: trustedFixture.request,
    },
    verifyPortalConfigurationAuthority: {
      portalConfigurationHash: portalConfiguration.configurationHash,
      request: trustedFixture.request,
    },
  });
  assert.deepEqual(trustFacetResults, {
    verifyCurrentCampaignReleaseAuthority: false,
    verifyVenueComplianceAuthority: false,
    verifyQualificationAuthority: false,
    verifyPortalConfigurationAuthority: true,
  });

  assert.throws(() => composePinnedAutonomousSubmissionRequestVerifier({
    root: runtimeRoot,
    runtimeRoot,
    clock: { now: () => new Date('invalid') },
    environment: {
      HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG: path.join(runtimeRoot, 'missing-venue.json'),
      HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH: H('venue-config'),
    },
  }), /autonomous_submission_request_verifier_clock_invalid/);
  assert.throws(() => composePinnedAutonomousSubmissionRequestVerifier({
    root: runtimeRoot,
    runtimeRoot,
    clock: { now: () => new Date(FIXED_TIME) },
    environment: {
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG:
        path.join(runtimeRoot, 'missing-portal.json'),
    },
    allowPortalCredential: true,
  }), /autonomous_submission_portal_configuration_file_invalid/);
  assert.throws(() => composePinnedAutonomousSubmissionRequestVerifier({
    root: runtimeRoot,
    runtimeRoot,
    clock: { now: () => new Date(FIXED_TIME) },
    environment: {
      HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG:
        path.join(runtimeRoot, 'missing-metadata.json'),
      HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH: H('metadata-config'),
    },
  }), /autonomous_submission_metadata_profile_config_invalid/);
});
