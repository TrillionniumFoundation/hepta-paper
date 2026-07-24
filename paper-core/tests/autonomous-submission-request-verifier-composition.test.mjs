import assert from 'node:assert/strict';
import fs from 'node:fs';
import inspector from 'node:inspector';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAutonomousSubmissionReceipt,
  buildAutonomousSubmissionRequest,
  createAutonomousSubmissionRequestVerifier,
  verifyAutonomousSubmissionReceipt,
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
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('AutonomousSubmissionOwnerCoverageTest', { label });
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

function qualificationInspection({ authority, releaseBinding }) {
  const receiptPayload = {
    version: 1,
    kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
    status: 'full_research_golden_micro_campaign_qualified',
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    qualificationScope: releaseBinding.qualificationScope,
    genericContentCanaryVerified: true,
    ...Object.fromEntries(PROOF_FIELDS.map((field) => [field, releaseBinding[field]])),
    venueProfileSelectionHash: releaseBinding.venueProfileSelectionHash,
    submissionMetadataReceiptHash: releaseBinding.submissionMetadataReceiptHash,
    signer: {
      keyId: 'submission-owner-qualification-key',
      keyVersion: 'v1',
      subjectId: 'submission-owner-qualification-attestor',
      organization: 'submission-owner-test-office',
      role: 'research_execution_release_attestor',
      algorithm: 'ed25519',
    },
    signature: 'submission-owner-detached-signature',
    externalActionPerformed: true,
  };
  const qualificationReceipt = Object.freeze({
    ...receiptPayload,
    fullResearchQualificationReceiptHash: hashRecord(
      'FullResearchGoldenMicroCampaignQualificationReceipt',
      receiptPayload,
    ),
  });
  const payload = {
    version: 1,
    kind: 'FullResearchQualificationInspection',
    status: 'full_research_qualification_verified',
    ready: true,
    receiptAccepted: true,
    qualificationSignatureVerified: true,
    qualificationTimeWindowVerified: true,
    releasePointerVerified: true,
    independentVerifierVerified: true,
    fullDomainVerificationReady: true,
    externalVerificationRequestHash: H('external-qualification-request'),
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    qualificationReceiptHash: qualificationReceipt.fullResearchQualificationReceiptHash,
    qualificationScope: releaseBinding.qualificationScope,
    genericContentCanaryVerified: true,
    ...Object.fromEntries(PROOF_FIELDS.map((field) => [field, releaseBinding[field]])),
    venueProfileSelectionHash: releaseBinding.venueProfileSelectionHash,
    submissionMetadataReceiptHash: releaseBinding.submissionMetadataReceiptHash,
    qualificationReceipt,
  };
  return Object.freeze({
    ...payload,
    fullResearchQualificationInspectionHash:
      hashRecord('FullResearchQualificationInspection', payload),
  });
}

function submissionFixture({ portalConfigurationHash = H('portal-configuration') } = {}) {
  const manuscript = genericManuscriptReleaseFixture({
    paperId: 'submission-owner-paper',
    campaignId: 'submission-owner-campaign',
    campaignPlanHash: H('campaign-plan'),
    proposalHash: H('proposal'),
    policyAuthorizationHash: H('policy'),
    seedBindingHash: H('seed'),
    externalSubmission: true,
  });
  const releaseBinding = manuscript.releaseBinding;
  const packagePayload = {
    version: 1,
    kind: 'ImmutableCampaignPackageOutput',
    immutable: true,
    sourceZipHash: H('source-zip'),
    authoritativeCompiledPdfHash: H('compiled-pdf'),
    independentRebuiltPdfHash: H('rebuilt-pdf'),
    packageVerificationReceiptHash: H('package-verification'),
    externalActionPerformed: false,
  };
  const packageOutput = Object.freeze({
    ...packagePayload,
    immutableCampaignPackageOutputHash:
      hashRecord('ImmutableCampaignPackageOutput', packagePayload),
  });
  const releasePayload = {
    version: 1,
    kind: 'CampaignReleaseBundle',
    status: 'campaign_release_bundle_prepared',
    campaignId: releaseBinding.campaignId,
    paperId: releaseBinding.paperId,
    venueTarget: manuscript.venueProfileSelection.venueId,
    campaignPlanHash: releaseBinding.campaignPlanHash,
    sourceSnapshotHash: H('source-snapshot'),
    sourceTreeManifestHash: H('source-tree'),
    researchEvidenceCapsuleManifestHash: H('evidence-capsule'),
    immutableCampaignPackageOutputHash: packageOutput.immutableCampaignPackageOutputHash,
    packageOutput,
    autonomousResearchReleaseBindingHash:
      releaseBinding.autonomousResearchReleaseBindingHash,
    autonomousResearchReleaseBinding: releaseBinding,
    createdAt: FIXED_TIME,
    externalActionPerformed: false,
  };
  const releaseBundle = Object.freeze({
    ...releasePayload,
    campaignReleaseBundleHash: hashRecord('CampaignReleaseBundle', releasePayload),
  });
  const authority = Object.freeze({
    status: 'current_completed_release',
    campaignId: releaseBinding.campaignId,
    paperId: releaseBinding.paperId,
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    releaseBundle,
  });
  const compliancePayload = {
    version: 1,
    kind: 'AutonomousVenueComplianceReceipt',
    status: 'autonomous_venue_compliance_verified',
    paperId: authority.paperId,
    campaignId: authority.campaignId,
    venueId: manuscript.venueProfileSelection.venueId,
    venueProfileHash: manuscript.venueProfileSelection.venueProfileHash,
    venueProfileSelectionHash: releaseBinding.venueProfileSelectionHash,
    submissionMetadataReceiptHash: releaseBinding.submissionMetadataReceiptHash,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    immutableCampaignPackageOutputHash: packageOutput.immutableCampaignPackageOutputHash,
    qualificationScope: releaseBinding.qualificationScope,
    trustedAutonomousManuscriptRenderReceiptHash:
      releaseBinding.trustedAutonomousManuscriptRenderReceiptHash,
    evidenceBoundManuscriptIrHash: releaseBinding.evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash: releaseBinding.manuscriptIrFileHash,
    renderedSourceHash: releaseBinding.renderedManuscriptHash,
    sourceArchiveHash: packageOutput.sourceZipHash,
    agentExecutionReceiptHash: releaseBinding.agentExecutionReceiptHash,
    isolatedAgentMergeReceiptHash: releaseBinding.isolatedAgentMergeReceiptHash,
    agentWorkspacePostimageBindingHash: releaseBinding.agentWorkspacePostimageBindingHash,
    compiledPdfHash: packageOutput.authoritativeCompiledPdfHash,
    independentRebuiltPdfHash: packageOutput.independentRebuiltPdfHash,
    pageCount: 5,
    documentClass: manuscript.venueProfileSelection.profile.documentClass,
    metadataPresent: Object.freeze([
      'abstract', 'authors', 'code_availability', 'conflict_of_interest',
      'data_availability', 'funding', 'keywords', 'title',
    ]),
    blockers: Object.freeze([]),
  };
  const venueComplianceReceipt = Object.freeze({
    ...compliancePayload,
    autonomousVenueComplianceReceiptHash:
      hashRecord('AutonomousVenueComplianceReceipt', compliancePayload),
  });
  const inspection = qualificationInspection({ authority, releaseBinding });
  const request = buildAutonomousSubmissionRequest({
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    venueProfileSelection: manuscript.venueProfileSelection,
    campaignReleaseAuthority: authority,
    qualificationInspection: inspection,
    venueComplianceReceipt,
    portalConfigurationHash,
    requestedAt: FIXED_TIME,
  });
  return Object.freeze({
    authority,
    inspection,
    manuscript,
    request,
    venueComplianceReceipt,
  });
}

function trustVerifier(overrides = {}) {
  return createAutonomousSubmissionRequestVerifier({
    verifyCurrentCampaignReleaseAuthority: () => true,
    verifyQualificationAuthority: () => true,
    verifyVenueComplianceAuthority: () => true,
    verifyPortalConfigurationAuthority: () => true,
    ...overrides,
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
  const verifier = trustVerifier();
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
  assert.equal(verifyAutonomousSubmissionReceipt(receipt, {
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
    completedReceiptVerifier: {
      kind: 'AutonomousSubmissionCompletedReceiptVerifier',
      verify: () => true,
    },
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

  const initialPermit = buildAutonomousSubmissionDispatchPermit({
    request: fixture.request,
    portalId: lookupInput.portalId,
    attempt: 1,
    previousState: 'prepared',
    previousStateReceiptHash: H('prepared-state'),
    dispatchStateReceiptHash: H('dispatching-state'),
    resolution: 'initial-dispatch',
  });
  assert.equal(verifyAutonomousSubmissionDispatchPermit(initialPermit, {
    request: fixture.request,
    portalId: lookupInput.portalId,
  }), true);
  const redrivePermit = buildAutonomousSubmissionDispatchPermit({
    request: fixture.request,
    portalId: lookupInput.portalId,
    attempt: 2,
    previousState: 'uncertain',
    previousStateReceiptHash: H('uncertain-state'),
    dispatchStateReceiptHash: H('redrive-state'),
    resolution: 'remote-authoritative-not-found-redrive',
    authoritativeNotFoundReceiptHash:
      notFound.autonomousSubmissionAuthoritativeNotFoundReceiptHash,
    onlineMutationSideEffectPermitHash: H('online-side-effect-permit'),
  });
  assert.equal(verifyAutonomousSubmissionDispatchPermit(redrivePermit, {
    request: fixture.request,
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
    request: fixture.request,
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
      previousStateReceiptHash: H('dispatching-state'), submissionReceipt: receipt,
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
      ...stateCase,
    });
    assert.equal(verifyAutonomousSubmissionDeliveryStateReceipt(stateReceipt, {
      request: fixture.request,
      requestVerifier: verifier,
    }), true, stateCase.state);
    assert.equal(verifyAutonomousSubmissionDeliveryStateReceipt(
      mutated(stateReceipt, 'recordedAt', 'invalid'),
      { request: fixture.request, requestVerifier: verifier },
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
