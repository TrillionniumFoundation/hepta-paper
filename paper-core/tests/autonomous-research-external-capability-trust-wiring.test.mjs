import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  buildAutonomousResearchAgendaProductionReceipt,
  buildAutonomousResearchAgendaProductionRequest,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  buildAutonomousResearchExternalCapabilityTrustInspection,
  verifyAutonomousResearchExternalCapabilityTrustInspection,
} from '../../paper-domain/automation/autonomous-research-external-capability-trust-contract.mjs';
import {
  inspectAutonomousResearchProductionProfileInputs,
} from '../../paper-domain/automation/autonomous-research-production-profile-contract.mjs';
import {
  buildSignedAutonomousVenueProfileRegistryConfiguration,
} from '../../paper-adapters/automation/autonomous-venue-profile-registry-reader.mjs';
import {
  buildSignedAutonomousSubmissionMetadataProfileConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-metadata-profile-reader.mjs';
import {
  buildAutonomousSubmissionPortalConfiguration,
  deriveAutonomousSubmissionPortalPublicConfiguration,
} from '../../paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  composeAutonomousResearchExternalCapabilities,
  inspectConfiguredAutonomousResearchCapabilityScope,
} from '../../paper-composition/automation/autonomous-research-external-capability-composition.mjs';
import {
  FIXED_TIME,
  productionSubmissionAuthoritiesFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('ExternalCapabilityTrustWiringTest', { label });

function freshSessionProviderInspections() {
  const credentialRootIdentityHash = H('fresh-provider-credential-root');
  const authorPayload = {
    version: 1,
    kind: 'CodexResearchAuthorCapabilityReceipt',
    status: 'codex_research_author_capability_ready',
    provider: 'openai',
    model: 'fresh-author-model',
    credentialRootIdentityHash,
    credentialConfigIdentityHash: H('fresh-author-credential-config'),
    freshEphemeralSessionRequired: true,
    priorAgentContextInheritanceForbidden: true,
  };
  const reviewerPayload = {
    version: 1,
    kind: 'CodexFormalReviewerCapabilityReceipt',
    status: 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model: 'fresh-reviewer-model',
    modelSelectionSource: 'codex_home_config',
    codexVersion: '0.144.1',
    codexBinaryIdentityHash: H('fresh-reviewer-binary'),
    credentialRootIdentityHash,
    credentialConfigIdentityHash: H('fresh-reviewer-credential-config'),
    authorProvider: 'codex',
    authorCredentialRootIdentityHash: credentialRootIdentityHash,
    credentialIndependenceVerified: false,
    providerCredentialSharingPermitted: true,
    freshEphemeralSessionRequired: true,
    authorContextInheritanceForbidden: true,
    frozenArtifactReviewRequired: true,
    reviewerMustDifferFromAuthorPrincipal: true,
    assuranceScope: 'ephemeral_session_frozen_artifact_and_role_separation',
    providerAccountIndependenceVerified: false,
    authenticationStatus: 'codex_authentication_verified',
    modelOptionVerified: true,
    selectedModelExecutionCanaryVerified: false,
    readOnlyReviewRequired: true,
    dynamicAttemptWorkspaceRequired: true,
  };
  return Object.freeze({
    researchAuthorPreflight: Object.freeze({
      effectivePrincipalId: 'fresh-session-author',
      capabilityReceipt: Object.freeze({
        ...authorPayload,
        codexResearchAuthorCapabilityReceiptHash: hashRecord(
          'CodexResearchAuthorCapabilityReceipt',
          authorPayload,
        ),
      }),
    }),
    formalReviewPreflight: Object.freeze({
      effectivePrincipalId: 'fresh-session-reviewer',
      capabilityReceipt: Object.freeze({
        ...reviewerPayload,
        codexFormalReviewerCapabilityReceiptHash: hashRecord(
          'CodexFormalReviewerCapabilityReceipt',
          reviewerPayload,
        ),
      }),
    }),
  });
}

function agendaReceipt(allowedProtocolFamilies) {
  const request = buildAutonomousResearchAgendaProductionRequest({
    paperId: 'external-capability-agenda',
    allowedProtocolFamilies,
  });
  const agentPayload = Object.freeze({
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    agentId: 'external-capability-agenda-producer',
    providerMode: 'test-provider',
    resolvedModel: 'test-model',
    promptHash: H('agenda-prompt'),
  });
  const agentExecutionReceipt = Object.freeze({
    ...agentPayload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', agentPayload),
  });
  return buildAutonomousResearchAgendaProductionReceipt({
    request,
    selectedObjective: 'Exercise the registered empirical capability scope.',
    selectedProtocolFamily: allowedProtocolFamilies[0],
    agentExecutionReceipt,
    producerId: 'external-capability-agenda-producer',
    generatedAt: '2026-07-20T00:00:00.000Z',
  });
}

function trustedComponent(label, extra = {}) {
  return Object.freeze({
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    configurationPinned: true,
    crashRecoveryReady: true,
    fullProductionReady: true,
    trustSetHash: H(`${label}:trust-set`),
    signatureVerificationPolicyHash: H(`${label}:signature-policy`),
    ...extra,
  });
}

function readyTrustInspection(overrides = {}) {
  return buildAutonomousResearchExternalCapabilityTrustInspection({
    priorArt: trustedComponent('prior-art', {
      evidenceProfile: 'structured-ranked-deduplicated-v2',
      ...overrides.priorArt,
    }),
    reviewerPool: trustedComponent('reviewer-pool'),
    externalReplay: trustedComponent('external-replay', overrides.externalReplay),
    submissionPortal: trustedComponent(
      'submission-portal',
      overrides.submissionPortal,
    ),
  });
}

function strongManifest({ priorArtMode = 'structured-ranked-deduplicated-v2',
  venueMode = 'submission-enabled-v1' } = {}) {
  return buildAutonomousResearchCapabilityScopeManifest({
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1'],
    empiricalFamilies: ['ml_algorithm_benchmark'],
    priorArtMode,
    reviewerPrincipalCount: 3,
    reviewerTrustDomainCount: 3,
    replayMode: 'external-trust-domain-v1',
    venueMode,
  });
}

test('strong production requires ranked prior art v2, submission, and bound external trust', () => {
  const trust = readyTrustInspection();
  assert.equal(verifyAutonomousResearchExternalCapabilityTrustInspection(trust), true);
  assert.equal(trust.ready, true);
  const manifest = strongManifest();
  assert.equal(manifest.genericDeclaredCapability, true);
  assert.equal(inspectAutonomousResearchProductionProfileInputs({
    launchMode: 'production-run',
    researchAgendaProducer: {},
    hypothesisGenerator: {},
    requireAgentAuthoredProse: true,
    capabilityScopeManifest: manifest,
    externalCapabilityTrustInspection: trust,
  }).ready, true);

  for (const weakManifest of [
    strongManifest({ priorArtMode: 'structured-receipt-v1' }),
    strongManifest({ venueMode: 'profile-selected-v1' }),
  ]) {
    assert.equal(weakManifest.genericDeclaredCapability, false);
    assert.equal(inspectAutonomousResearchProductionProfileInputs({
      launchMode: 'production-run',
      researchAgendaProducer: {},
      hypothesisGenerator: {},
      requireAgentAuthoredProse: true,
      capabilityScopeManifest: weakManifest,
      externalCapabilityTrustInspection: trust,
    }).ready, false);
  }
  const untrusted = readyTrustInspection({
    externalReplay: { identityIndependenceReady: false },
  });
  assert.equal(untrusted.ready, false);
  assert.equal(inspectAutonomousResearchProductionProfileInputs({
    launchMode: 'production-run',
    researchAgendaProducer: {},
    hypothesisGenerator: {},
    requireAgentAuthoredProse: true,
    capabilityScopeManifest: manifest,
    externalCapabilityTrustInspection: untrusted,
  }).ready, false);
  const unpinnedPriorArt = readyTrustInspection({
    priorArt: {
      configurationPinned: false,
      fullProductionReady: false,
    },
  });
  assert.equal(unpinnedPriorArt.ready, false);
  assert.ok(unpinnedPriorArt.blockers.includes(
    'autonomous_research_prior_art_configuration_not_pinned',
  ));
  const unpinnedPortal = readyTrustInspection({
    submissionPortal: {
      configurationPinned: false,
      fullProductionReady: false,
    },
  });
  assert.equal(unpinnedPortal.ready, false);
  assert.ok(unpinnedPortal.blockers.includes(
    'autonomous_research_submission_portal_configuration_not_pinned',
  ));
  assert.ok(unpinnedPortal.blockers.includes(
    'autonomous_research_submission_portal_full_production_not_ready',
  ));
  const replayWithoutRecovery = readyTrustInspection({
    externalReplay: {
      crashRecoveryReady: false,
      fullProductionReady: false,
    },
  });
  assert.equal(replayWithoutRecovery.ready, false);
  assert.ok(replayWithoutRecovery.blockers.includes(
    'autonomous_research_external_replay_crash_recovery_not_ready',
  ));
  assert.equal(inspectAutonomousResearchProductionProfileInputs({
    launchMode: 'golden-bootstrap',
    capabilityScopeManifest: strongManifest({ venueMode: 'profile-selected-v1' }),
  }).ready, true);
});

test('external capability composition derives trust from ports instead of adapter presence', () => {
  const priorArt = Object.freeze({
    kind: 'PriorArtRetrievalPort',
    evidenceProfile: 'structured-ranked-deduplicated-v2',
    retrieve: async () => null,
    ...trustedComponent('prior-art'),
  });
  const reviewerPrincipalPoolInspection = Object.freeze({
    pool: Object.freeze({ reviewerPrincipalCount: 3, reviewerTrustDomainCount: 3 }),
    ...trustedComponent('reviewer-pool'),
  });
  const submissionPortal = Object.freeze({
    kind: 'AutonomousSubmissionPortalPort',
    idempotencyLookupSupported: true,
    ...trustedComponent('submission-portal'),
  });
  const composition = composeAutonomousResearchExternalCapabilities({
    paperId: 'trust-wiring-paper',
    refereeCount: 3,
    requestedContentMode: 'agent-evidence-bound',
    dynamicFormalClaimsEnabled: true,
    reviewerPrincipalPoolInspection,
    priorArtRetriever: priorArt,
    externalResearchReplay: trustedComponent('external-replay'),
    autonomousSubmissionPortal: submissionPortal,
    autonomousSubmissionRequestVerifier: Object.freeze({
      version: 1,
      kind: 'AutonomousSubmissionRequestVerifier',
      verify: () => true,
    }),
    requestedProtocolFamily: 'ml_algorithm_benchmark',
    environment: {},
  });
  assert.equal(composition.externalCapabilityTrustInspection.ready, true);
  assert.equal(
    composition.contentCapabilityScopeManifest.priorArtMode,
    'structured-ranked-deduplicated-v2',
  );
  assert.ok(composition.contentCapabilityScopeManifest.externalPrerequisites
    .includes('venue-profile-registry'));

  const weakComposition = composeAutonomousResearchExternalCapabilities({
    paperId: 'trust-wiring-paper-weak',
    refereeCount: 3,
    requestedContentMode: 'agent-evidence-bound',
    dynamicFormalClaimsEnabled: true,
    reviewerPrincipalPoolInspection,
    priorArtRetriever: priorArt,
    externalResearchReplay: trustedComponent('external-replay', {
      identityIndependenceReady: false,
    }),
    autonomousSubmissionPortal: submissionPortal,
    autonomousSubmissionRequestVerifier: Object.freeze({
      version: 1,
      kind: 'AutonomousSubmissionRequestVerifier',
      verify: () => true,
    }),
    requestedProtocolFamily: 'ml_algorithm_benchmark',
    environment: {},
  });
  assert.equal(weakComposition.externalCapabilityTrustInspection.ready, false);
  assert.ok(weakComposition.contentCapabilityScopeManifest.externalPrerequisites
    .includes('autonomous_research_external_replay_identity_independence_not_ready'));
});

test('external capability inspection reports every missing or malformed configured boundary', (t) => {
  const empty = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {},
    providerInspections: {},
  });
  assert.equal(empty.priorArtServiceConfigured, false);
  assert.equal(empty.externalReplayServiceConfigured, false);
  assert.equal(empty.venueProfileRegistryConfigured, false);
  assert.equal(empty.submissionPortalConfigured, false);
  assert.equal(empty.submissionMetadataProfileConfigured, false);
  assert.equal(empty.manifest.venueMode, 'disabled');

  const malformed = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {
      HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: ' AGENT-EVIDENCE-BOUND ',
      HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED: ' YES ',
      HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG: '/missing/reviewer-pool.json',
      HEPTA_PRIOR_ART_SERVICE_CONFIG: '/missing/prior-art.json',
      HEPTA_EXTERNAL_REPLAY_CONFIG: '/missing/external-replay.json',
      HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG: '/missing/venue.json',
      HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH: H('wrong-venue-config'),
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: '/missing/submission.json',
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH: H('wrong-submission-config'),
      HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG: '/missing/metadata.json',
      HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH: H('wrong-metadata-config'),
    },
    providerInspections: {},
    researchAgendaProducerReceipt: Object.freeze({ kind: 'invalid-agenda-receipt' }),
  });
  assert.ok(malformed.blockers.some((item) => item.startsWith('reviewer-principal-pool:')));
  assert.ok(malformed.blockers.some((item) => item.startsWith('prior-art-service:')));
  assert.ok(malformed.blockers.some((item) => item.startsWith('external-replay-service:')));
  assert.ok(malformed.blockers.some((item) => item.startsWith('venue-profile-registry:')));
  assert.ok(malformed.blockers.some((item) => item.startsWith('submission-portal-service:')));
  assert.ok(malformed.blockers.some((item) => item.startsWith('submission-metadata-profile:')));
  assert.ok(malformed.manifest.externalPrerequisites.includes('machine-generated-agenda-receipt'));
  assert.ok(malformed.manifest.externalPrerequisites.includes('signed-venue-profile-registry'));
  assert.ok(malformed.manifest.externalPrerequisites.includes('signed-submission-metadata-profile'));
  assert.deepEqual(malformed.manifest.formalClaimClasses, [
    'dynamic-lean-type-v1',
    'registered-template-v1',
  ]);

  const empiricalFamilies = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY.profiles
    .filter((profile) => profile.productionExecutable === true)
    .map((profile) => profile.benchmarkFamily)
    .sort();
  const machineAgenda = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {},
    providerInspections: {},
    researchAgendaProducerReceipt: agendaReceipt(empiricalFamilies),
  });
  assert.equal(machineAgenda.manifest.agendaMode, 'machine-generated');
  const partialAgenda = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {},
    providerInspections: {},
    researchAgendaProducerReceipt: agendaReceipt(empiricalFamilies.slice(0, 1)),
  });
  assert.equal(partialAgenda.manifest.agendaMode, 'registered-profile');
  const missingUnsignedConfigurations = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {
      HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG: '/missing/unsigned-venue.json',
      HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG: '/missing/unsigned-metadata.json',
    },
    providerInspections: {},
  });
  assert.ok(missingUnsignedConfigurations.blockers.some((item) => item.startsWith(
    'venue-profile-registry:',
  )));
  assert.ok(missingUnsignedConfigurations.blockers.some((item) => item.startsWith(
    'submission-metadata-profile:',
  )));

  const invalidAuthorPin = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH: 'not-a-sha256-pin',
    },
  });
  assert.ok(invalidAuthorPin.blockers.includes(
    'research-author-identity:autonomous_research_author_identity_configuration_pin_invalid',
  ));

  const reviewerPreflightAttempt = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {
      HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG: '/missing/reviewer-pool-with-author.json',
    },
    providerInspections: Object.freeze({
      researchAuthorPreflight: Object.freeze({ codexHome: '/nonexistent/codex-home' }),
    }),
    providerSpawnSync: () => Object.freeze({ status: 1, stdout: '', stderr: '' }),
    reviewerPreflight: () => Object.freeze({ ready: false }),
  });
  assert.ok(reviewerPreflightAttempt.blockers.some((item) => item.startsWith(
    'reviewer-principal-pool:',
  )));

  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-capability-inspection-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const selection = productionSubmissionAuthoritiesFixture({
    paperId: 'capability-inspection-paper',
    protocolFamily: 'ml_algorithm_benchmark',
    objective: 'Assess machine learning algorithm evidence.',
  }).venueProfileSelection;
  const rawVenuePath = path.join(runtimeRoot, 'raw-venue.json');
  const rawMetadataPath = path.join(runtimeRoot, 'raw-metadata.json');
  fs.writeFileSync(rawVenuePath, JSON.stringify(selection.registry), { mode: 0o600 });
  fs.writeFileSync(rawMetadataPath, JSON.stringify(selection.submissionMetadataProfile), {
    mode: 0o600,
  });
  const rawConfiguration = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {
      HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG: rawVenuePath,
      HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG: rawMetadataPath,
    },
    providerInspections: {},
  });
  assert.equal(rawConfiguration.venueProfileRegistryConfigured, true);
  assert.equal(rawConfiguration.submissionMetadataProfileConfigured, true);
  assert.equal(rawConfiguration.manifest.venueMode, 'profile-selected-v1');
  assert.ok(rawConfiguration.manifest.externalPrerequisites.includes(
    'submission-portal-service',
  ));

  const venueProof = selection.registryAuthorityProof;
  const metadataProof = selection.submissionMetadataAuthorityProof;
  const maximumLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
  const signedVenue = buildSignedAutonomousVenueProfileRegistryConfiguration({
    registry: selection.registry,
    templateAssets: selection.venueTemplateAssetBundle.assets,
    trustStore: venueProof.trustStore,
    authorityEnvelope: venueProof.authorityEnvelope,
    expectedKeyIds: venueProof.expectedKeyIds,
    maximumLifetimeMs,
    observedAt: FIXED_TIME,
  });
  const signedMetadata = buildSignedAutonomousSubmissionMetadataProfileConfiguration({
    profile: selection.submissionMetadataProfile,
    trustStore: metadataProof.trustStore,
    authorityEnvelope: metadataProof.authorityEnvelope,
    expectedKeyIds: metadataProof.expectedKeyIds,
    maximumLifetimeMs,
    observedAt: FIXED_TIME,
  });
  const signedVenuePath = path.join(runtimeRoot, 'signed-venue.json');
  const signedMetadataPath = path.join(runtimeRoot, 'signed-metadata.json');
  fs.writeFileSync(signedVenuePath, JSON.stringify(signedVenue), { mode: 0o600 });
  fs.writeFileSync(signedMetadataPath, JSON.stringify(signedMetadata), { mode: 0o600 });
  const portalConfiguration = buildAutonomousSubmissionPortalConfiguration({
    portalId: 'capability-inspection-portal',
    endpoint: 'https://submission.example.test/v1/',
    serviceIdentityHash: H('capability-inspection-portal-service'),
    portalAccountIdentityHash: H('capability-inspection-portal-account'),
    portalTrustDomainIdentityHash: H('capability-inspection-portal-domain'),
    tokenEnvironmentVariable: 'CAPABILITY_INSPECTION_PORTAL_TOKEN',
  });
  const portalDescriptor = deriveAutonomousSubmissionPortalPublicConfiguration({
    configuration: portalConfiguration,
  });
  const portalDescriptorPath = path.join(runtimeRoot, 'submission-portal-descriptor.json');
  fs.writeFileSync(portalDescriptorPath, JSON.stringify(portalDescriptor), { mode: 0o600 });
  const NativeDate = globalThis.Date;
  let signedConfiguration;
  try {
    globalThis.Date = class FixedCapabilityInspectionDate extends NativeDate {
      constructor(...args) {
        super(...(args.length > 0 ? args : [FIXED_TIME]));
      }

      static now() { return NativeDate.parse(FIXED_TIME); }
    };
    signedConfiguration = inspectConfiguredAutonomousResearchCapabilityScope({
      environment: {
        HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG: signedVenuePath,
        HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH: signedVenue.configurationHash,
        HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG: signedMetadataPath,
        HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH: signedMetadata.configurationHash,
        HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: portalDescriptorPath,
        HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
          portalConfiguration.configurationHash,
        HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH:
          autonomousSubmissionPortalPublicDescriptorHash(portalDescriptor),
      },
      providerInspections: {},
      providerSpawnSync: () => Object.freeze({
        status: 0,
        stdout: `${process.execPath}\n`,
        stderr: '',
      }),
    });
  } finally {
    globalThis.Date = NativeDate;
  }
  assert.equal(
    signedConfiguration.venueProfileRegistryAuthorityReady,
    true,
    JSON.stringify(signedConfiguration.blockers),
  );
  assert.equal(
    signedConfiguration.submissionMetadataAuthorityReady,
    true,
    JSON.stringify(signedConfiguration.blockers),
  );
  assert.equal(signedConfiguration.submissionPortalConfigured, true);
  assert.equal(signedConfiguration.venueComplianceRuntimeReady, true);
  assert.equal(signedConfiguration.manifest.venueMode, 'submission-enabled-v1');
});

test('configured capability inspection binds fresh provider session identities', () => {
  const inspection = inspectConfiguredAutonomousResearchCapabilityScope({
    environment: {},
    providerInspections: freshSessionProviderInspections(),
  });
  assert.equal(inspection.authorIdentityAttestationReady, true);
  assert.equal(inspection.authorIdentityCryptographicAuthorityReady, false);
  assert.equal(inspection.authorIdentityFullProductionReady, false);
  assert.match(inspection.authorIdentitySubjectHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(inspection.authorIdentityAttestation.identityMode,
    'fresh-ephemeral-session-policy');
  assert.equal(inspection.authorIdentityAttestation.sessionIsolationReady, true);
  assert.equal(inspection.manifest.externalPrerequisites.includes(
    'independent-reviewer-session-isolation',
  ), false);
  assert.equal(
    inspection.externalCapabilityTrustInspection.components.reviewerPool.ready,
    true,
  );
});

test('external capability composition rejects partial submission and identity wiring', () => {
  const authorIdentitySubjectHash = H('author-identity-subject');
  const venueRegistry = Object.freeze({
    profiles: Object.freeze([Object.freeze({
      externalSubmissionEnabled: true,
      bibliographyStyle: 'unsupported-bibliography',
      citationStyle: 'unsupported-citations',
    })]),
  });
  const submissionPortal = Object.freeze({
    kind: 'AutonomousSubmissionPortalPort',
    idempotencyLookupSupported: false,
    identitySeparationInspection: Object.freeze({
      localOriginIdentitySubjects: Object.freeze([]),
    }),
  });
  const externalReplay = Object.freeze({
    identitySeparationInspection: Object.freeze({
      localOriginIdentitySubjects: Object.freeze([]),
    }),
  });
  const partial = composeAutonomousResearchExternalCapabilities({
    paperId: 'partial-capability-wiring',
    refereeCount: 3,
    requestedContentMode: 'deterministic-bounded',
    dynamicFormalClaimsEnabled: true,
    venueProfileRegistry: venueRegistry,
    submissionMetadataProfile: Object.freeze({ profileId: 'metadata-partial' }),
    externalResearchReplay: externalReplay,
    autonomousSubmissionPortal: submissionPortal,
    authorIdentityAttestation: Object.freeze({
      subject: Object.freeze({ externalPrincipalIdentityAttestationSubjectHash: authorIdentitySubjectHash }),
    }),
    requestedProtocolFamily: 'unsupported-family',
    environment: {},
    spawnSyncImpl: () => Object.freeze({ status: 1, stdout: '', stderr: 'runtime unavailable' }),
  });
  for (const blocker of [
    'autonomous_research_submission_portal_idempotency_lookup_required',
    'autonomous_research_external_replay_author_identity_binding_required',
    'autonomous_research_submission_portal_author_identity_binding_required',
    'autonomous_research_submission_request_verifier_required',
    'autonomous_research_dynamic_formal_claims_require_agent_content',
  ]) assert.ok(partial.blockers.includes(blocker), blocker);
  for (const prerequisite of [
    'structured-prior-art-service',
    'independent-reviewer-session-isolation',
    'submission-request-verifier',
    'venue-compliance-runtime',
    'venue-rendering-profile',
  ]) assert.ok(partial.contentCapabilityScopeManifest.externalPrerequisites.includes(prerequisite), prerequisite);
  assert.equal(partial.contentCapabilityScopeManifest.venueMode, 'profile-selected-v1');

  const malformedConfiguration = composeAutonomousResearchExternalCapabilities({
    paperId: 'malformed-capability-wiring',
    refereeCount: 1,
    requestedContentMode: 'agent-evidence-bound',
    dynamicFormalClaimsEnabled: false,
    requestedProtocolFamily: 'ml_algorithm_benchmark',
    environment: {
      HEPTA_EXTERNAL_REPLAY_CONFIG: '/missing/external-replay.json',
      HEPTA_PRIOR_ART_SERVICE_CONFIG: '/missing/prior-art.json',
      HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG: '/missing/venue.json',
      HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG: '/missing/metadata.json',
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: '/missing/submission.json',
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH: H('wrong-submission-config'),
    },
  });
  assert.ok(malformedConfiguration.blockers.some((item) => item.startsWith(
    'autonomous_research_external_replay_invalid:',
  )));
  assert.ok(malformedConfiguration.blockers.some((item) => item.startsWith(
    'autonomous_research_prior_art_service_invalid:',
  )));
  assert.ok(malformedConfiguration.blockers.some((item) => item.startsWith(
    'autonomous_research_venue_profile_invalid:',
  )));
  assert.ok(malformedConfiguration.blockers.some((item) => item.startsWith(
    'autonomous_research_submission_metadata_invalid:',
  )));
  assert.ok(malformedConfiguration.blockers.some((item) => item.startsWith(
    'autonomous_research_submission_portal_invalid:',
  )));
  assert.ok(malformedConfiguration.contentCapabilityScopeManifest.externalPrerequisites
    .includes('signed-venue-profile-registry'));
  assert.ok(malformedConfiguration.contentCapabilityScopeManifest.externalPrerequisites
    .includes('signed-submission-metadata-profile'));
});

test('fully injected external capabilities close signed submission and identity bindings', () => {
  const authorIdentitySubjectHash = H('fully-wired-author-subject');
  const signedAuthority = (label) => Object.freeze({
    configurationPinned: true,
    cryptographicAuthorityReady: true,
    configurationHash: H(`${label}:configuration`),
    trustSetHash: H(`${label}:trust-set`),
    signatureVerificationPolicyHash: H(`${label}:signature-policy`),
  });
  const reviewerPrincipalPoolInspection = Object.freeze({
    pool: Object.freeze({
      reviewerPrincipalCount: 3,
      reviewerTrustDomainCount: 3,
      researchPrincipalPoolHash: H('fully-wired-reviewer-pool'),
    }),
    ...trustedComponent('fully-wired-reviewer-pool'),
  });
  const priorArt = Object.freeze({
    evidenceProfile: 'structured-ranked-deduplicated-v2',
    ...trustedComponent('fully-wired-prior-art'),
  });
  const externalReplay = Object.freeze({
    ...trustedComponent('fully-wired-external-replay'),
    receiptVerifier: Object.freeze({
      identitySeparationInspection: Object.freeze({
        localOriginIdentitySubjects: Object.freeze([Object.freeze({
          externalPrincipalIdentityAttestationSubjectHash: authorIdentitySubjectHash,
        })]),
      }),
    }),
  });
  const submissionPortal = Object.freeze({
    idempotencyLookupSupported: true,
    ...trustedComponent('fully-wired-submission-portal'),
    identitySeparationInspection: Object.freeze({
      localOriginIdentitySubjects: Object.freeze([Object.freeze({
        externalPrincipalIdentityAttestationSubjectHash: authorIdentitySubjectHash,
      })]),
    }),
  });
  const venueProfileRegistry = Object.freeze({
    profiles: Object.freeze([Object.freeze({
      externalSubmissionEnabled: true,
      bibliographyStyle: 'inline-evidence-v1',
      citationStyle: 'evidence-inline-v1',
    })]),
  });
  const composition = composeAutonomousResearchExternalCapabilities({
    paperId: 'fully-wired-capability-paper',
    refereeCount: 3,
    requestedContentMode: 'agent-evidence-bound',
    dynamicFormalClaimsEnabled: true,
    reviewerPrincipalPoolInspection,
    venueProfileRegistry,
    venueProfileRegistryAuthority: signedAuthority('venue'),
    submissionMetadataProfile: Object.freeze({ profileId: 'fully-wired-metadata' }),
    submissionMetadataAuthority: signedAuthority('metadata'),
    priorArtRetriever: priorArt,
    externalResearchReplay: externalReplay,
    autonomousSubmissionPortal: submissionPortal,
    autonomousSubmissionRequestVerifier: Object.freeze({
      version: 1,
      kind: 'AutonomousSubmissionRequestVerifier',
      verify: () => true,
    }),
    authorIdentityAttestation: Object.freeze({
      subject: Object.freeze({ externalPrincipalIdentityAttestationSubjectHash: authorIdentitySubjectHash }),
    }),
    requestedProtocolFamily: 'ml_algorithm_benchmark',
    environment: {},
    spawnSyncImpl: () => Object.freeze({ status: 0, stdout: `${process.execPath}\n`, stderr: '' }),
  });
  assert.equal(composition.contentCapabilityScopeManifest.venueMode, 'submission-enabled-v1');
  assert.equal(composition.contentCapabilityScopeManifest.priorArtMode, 'structured-ranked-deduplicated-v2');
  assert.equal(composition.contentCapabilityScopeManifest.replayMode, 'external-trust-domain-v1');
  assert.equal(composition.venueComplianceRuntimeInspection.ready, true);
  assert.equal(composition.externalCapabilityTrustInspection.ready, true);
  assert.deepEqual(composition.blockers, []);
  assert.deepEqual(composition.contentCapabilityScopeManifest.externalPrerequisites, []);
  assert.equal(composition.capabilityRequestCoverage.ready, true);
});

test('external capability composition enumerates short-circuit trust failures', () => {
  const externalVenue = Object.freeze({
    profiles: Object.freeze([Object.freeze({
      externalSubmissionEnabled: true,
      bibliographyStyle: 'inline-evidence-v1',
      citationStyle: 'evidence-inline-v1',
    })]),
  });
  const venueOnly = composeAutonomousResearchExternalCapabilities({
    paperId: 'venue-only-capabilities',
    refereeCount: 2,
    requestedContentMode: 'deterministic-bounded',
    dynamicFormalClaimsEnabled: false,
    reviewerPrincipalPoolInspection: Object.freeze({ pool: Object.freeze({}) }),
    venueProfileRegistry: externalVenue,
    priorArtRetriever: Object.freeze({ evidenceProfile: 'structured-receipt-v1' }),
    externalResearchReplay: Object.freeze({
      receiptVerifier: Object.freeze({
        identitySeparationInspection: Object.freeze({
          localOriginIdentitySubjects: Object.freeze([Object.freeze({})]),
        }),
      }),
    }),
    requestedProtocolFamily: 'ml_algorithm_benchmark',
    environment: {},
  });
  assert.equal(venueOnly.contentCapabilityScopeManifest.priorArtMode, 'structured-receipt-v1');
  assert.ok(venueOnly.contentCapabilityScopeManifest.externalPrerequisites
    .includes('submission-portal-service'));
  assert.ok(venueOnly.contentCapabilityScopeManifest.externalPrerequisites
    .includes('submission-metadata-profile'));

  const validSubmissionVerifier = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionRequestVerifier',
    verify: () => true,
  });
  const signedAuthority = (label) => Object.freeze({
    configurationPinned: true,
    cryptographicAuthorityReady: true,
    configurationHash: H(`${label}:configuration`),
    trustSetHash: H(`${label}:trust-set`),
    signatureVerificationPolicyHash: H(`${label}:signature-policy`),
  });
  const portal = Object.freeze({ idempotencyLookupSupported: true });
  const metadata = Object.freeze({ profileId: 'short-circuit-metadata' });
  const shortCircuitCases = [
    Object.freeze({ autonomousSubmissionPortal: portal }),
    Object.freeze({
      autonomousSubmissionPortal: portal,
      autonomousSubmissionRequestVerifier: validSubmissionVerifier,
    }),
    Object.freeze({
      autonomousSubmissionPortal: portal,
      autonomousSubmissionRequestVerifier: validSubmissionVerifier,
      submissionMetadataProfile: metadata,
    }),
    Object.freeze({
      autonomousSubmissionPortal: portal,
      autonomousSubmissionRequestVerifier: validSubmissionVerifier,
      submissionMetadataProfile: metadata,
      venueProfileRegistryAuthority: signedAuthority('short-circuit-venue'),
    }),
    Object.freeze({
      autonomousSubmissionPortal: portal,
      autonomousSubmissionRequestVerifier: validSubmissionVerifier,
      submissionMetadataProfile: metadata,
      venueProfileRegistryAuthority: signedAuthority('short-circuit-venue'),
      submissionMetadataAuthority: signedAuthority('short-circuit-metadata'),
      spawnSyncImpl: () => Object.freeze({ status: 1, stdout: '', stderr: 'not ready' }),
    }),
  ];
  for (const [index, overrides] of shortCircuitCases.entries()) {
    const candidate = composeAutonomousResearchExternalCapabilities({
      paperId: `submission-short-circuit-${index}`,
      refereeCount: 1,
      requestedContentMode: 'deterministic-bounded',
      dynamicFormalClaimsEnabled: false,
      venueProfileRegistry: externalVenue,
      requestedProtocolFamily: 'ml_algorithm_benchmark',
      environment: {},
      ...overrides,
    });
    assert.equal(candidate.contentCapabilityScopeManifest.venueMode, 'profile-selected-v1');
  }

  const invalidVerifierVariants = [
    Object.freeze({ version: 0, kind: 'AutonomousSubmissionRequestVerifier', verify: () => true }),
    Object.freeze({ version: 1, kind: 'WrongVerifier', verify: () => true }),
    Object.freeze({ version: 1, kind: 'AutonomousSubmissionRequestVerifier', verify: true }),
  ];
  for (const [index, verifier] of invalidVerifierVariants.entries()) {
    const candidate = composeAutonomousResearchExternalCapabilities({
      paperId: `invalid-submission-verifier-${index}`,
      refereeCount: 1,
      requestedContentMode: 'agent-evidence-bound',
      dynamicFormalClaimsEnabled: false,
      venueProfileRegistry: externalVenue,
      submissionMetadataProfile: Object.freeze({ profileId: 'metadata' }),
      autonomousSubmissionPortal: Object.freeze({ idempotencyLookupSupported: true }),
      autonomousSubmissionRequestVerifier: verifier,
      requestedProtocolFamily: 'ml_algorithm_benchmark',
      environment: {},
      spawnSyncImpl: () => { throw new Error('venue runtime probe failed'); },
    });
    assert.ok(candidate.blockers.includes('autonomous_research_submission_request_verifier_required'));
    assert.ok(candidate.blockers.some((item) => item.startsWith(
      'autonomous_research_venue_compliance_runtime_invalid:',
    )));
  }

  for (const [index, authority] of [
    null,
    Object.freeze({ configurationPinned: true }),
    Object.freeze({ configurationPinned: true, cryptographicAuthorityReady: true }),
    Object.freeze({
      configurationPinned: true,
      cryptographicAuthorityReady: true,
      configurationHash: H('partial-authority-configuration'),
    }),
    Object.freeze({
      configurationPinned: true,
      cryptographicAuthorityReady: true,
      configurationHash: H('partial-authority-configuration'),
      trustSetHash: H('partial-authority-trust'),
    }),
  ].entries()) {
    const candidate = composeAutonomousResearchExternalCapabilities({
      paperId: `partial-signed-authority-${index}`,
      refereeCount: 1,
      requestedContentMode: 'agent-evidence-bound',
      dynamicFormalClaimsEnabled: false,
      venueProfileRegistry: Object.freeze({ profiles: Object.freeze([]) }),
      venueProfileRegistryAuthority: authority,
      submissionMetadataAuthority: authority,
      requestedProtocolFamily: 'ml_algorithm_benchmark',
      environment: {},
    });
    assert.ok(candidate.contentCapabilityScopeManifest.externalPrerequisites
      .includes('signed-venue-profile-registry'));
    assert.ok(candidate.contentCapabilityScopeManifest.externalPrerequisites
      .includes('signed-submission-metadata-profile'));
  }

  const identityFallbacks = [
    Object.freeze({}),
    Object.freeze({
      identitySeparationInspection: Object.freeze({
        localOriginIdentitySubjects: Object.freeze([Object.freeze({})]),
      }),
    }),
  ];
  for (const [index, externalResearchReplay] of identityFallbacks.entries()) {
    const candidate = composeAutonomousResearchExternalCapabilities({
      paperId: `identity-fallback-${index}`,
      refereeCount: 1,
      requestedContentMode: 'deterministic-bounded',
      dynamicFormalClaimsEnabled: false,
      externalResearchReplay,
      authorIdentityAttestation: Object.freeze({
        subject: Object.freeze({
          externalPrincipalIdentityAttestationSubjectHash: H(`fallback-author-${index}`),
        }),
      }),
      requestedProtocolFamily: 'ml_algorithm_benchmark',
      environment: {},
    });
    assert.ok(candidate.blockers.includes(
      'autonomous_research_external_replay_author_identity_binding_required',
    ));
  }

  for (const [index, spawnSyncImpl] of [
    undefined,
    () => { throw 'string venue runtime failure'; },
    () => { throw undefined; },
  ].entries()) {
    const candidate = composeAutonomousResearchExternalCapabilities({
      paperId: `venue-runtime-branch-${index}`,
      refereeCount: 1,
      requestedContentMode: 'deterministic-bounded',
      dynamicFormalClaimsEnabled: false,
      venueProfileRegistry: externalVenue,
      submissionMetadataProfile: Object.freeze({ profileId: 'metadata' }),
      autonomousSubmissionPortal: Object.freeze({ idempotencyLookupSupported: true }),
      autonomousSubmissionRequestVerifier: Object.freeze({
        version: 1,
        kind: 'AutonomousSubmissionRequestVerifier',
        verify: () => true,
      }),
      requestedProtocolFamily: 'ml_algorithm_benchmark',
      environment: {},
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    });
    if (index > 0) assert.ok(candidate.blockers.some((item) => item.startsWith(
      'autonomous_research_venue_compliance_runtime_invalid:',
    )));
  }
});
