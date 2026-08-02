import {
  buildAutonomousResearchCapabilityScopeManifest,
  evaluateAutonomousResearchCapabilityRequestCoverage,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  readAutonomousVenueProfileRegistry,
} from '../../paper-adapters/automation/autonomous-venue-profile-registry-reader.mjs';
import {
  createHttpPriorArtRetrievalAdapter,
  readPriorArtServiceConfiguration,
} from '../../paper-adapters/automation/http-prior-art-retrieval-adapter.mjs';
import {
  createHttpExternalResearchReplayAdapter,
  readExternalResearchReplayServiceConfiguration,
} from '../../paper-adapters/automation/http-external-research-replay-adapter.mjs';
import {
  preflightReviewerPrincipalPool,
} from './reviewer-principal-pool-composition.mjs';
import {
  autonomousResearchAuthorIdentitySubjectHash,
  buildAutonomousResearchReviewerSessionPrincipalPool,
  inspectAutonomousResearchAuthorRuntimeIdentity,
} from './autonomous-research-runtime-principal-preflight.mjs';
import {
  createAutonomousSubmissionPortalDescriptor,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  readConfiguredAutonomousSubmissionPortalDescriptorConfiguration,
} from '../../paper-adapters/automation/autonomous-submission-portal-descriptor-reader.mjs';
import {
  readAutonomousSubmissionMetadataProfile,
} from '../../paper-adapters/automation/autonomous-submission-metadata-profile-reader.mjs';
import {
  inspectLocalAutonomousVenueComplianceRuntime,
} from '../../paper-adapters/automation/local-autonomous-venue-compliance-inspector.mjs';
import {
  buildAutonomousResearchExternalCapabilityTrustInspection,
} from '../../paper-domain/automation/autonomous-research-external-capability-trust-contract.mjs';
import {
  createReviewerReceiptVerificationAuthority,
} from '../../paper-adapters/automation/reviewer-principal-executor-pool.mjs';
import {
  activeAutonomousResearchProductionEmpiricalFamilies as activeProductionEmpiricalFamilies,
  autonomousResearchExternalCapabilityErrorCode as errorCode,
  autonomousResearchExternalReplayVerificationSurface as externalReplayReceiptVerificationSurface,
  autonomousResearchLocalOriginIdentitySubjectHashes as localOriginIdentitySubjectHashes,
  autonomousResearchMetadataConfiguration as metadataConfiguration,
  autonomousResearchReviewerTrustSurface as reviewerTrustSurface,
  autonomousResearchSignedConfigurationReady as signedConfigurationReady,
  autonomousResearchVenueConfiguration as venueConfiguration,
  autonomousResearchVenueTemplateAssetsReady as venueTemplateAssetsReady,
  autonomousSubmissionRequestVerifierReady as submissionRequestVerifierReady,
  configuredAutonomousResearchPriorArtMode as configuredPriorArtMode,
} from './autonomous-research-external-capability-configuration.mjs';

function isolatedReviewerSessionTrustSurface({ author, reviewer } = {}) {
  try {
    return reviewerTrustSurface(
      buildAutonomousResearchReviewerSessionPrincipalPool({ author, reviewer }),
    );
  } catch {
    return null;
  }
}

function authorIdentityTrustSurface(inspection) {
  if (!inspection) return null;
  const subjectHash = autonomousResearchAuthorIdentitySubjectHash(inspection);
  const cryptographicAuthorityReady = inspection.cryptographicAuthorityReady === true;
  const stablePolicyPinned = inspection.stablePolicyPinned === true;
  const fullProductionReady = inspection.ready === true
    && inspection.configurationPinned === true
    && stablePolicyPinned
    && cryptographicAuthorityReady
    && subjectHash !== null;
  return Object.freeze({
    status: inspection.status || null,
    ready: inspection.ready === true,
    identityMode: inspection.identityMode
      || (cryptographicAuthorityReady ? 'external-cryptographic-attestation' : null),
    cryptographicAuthorityReady,
    sessionIsolationReady: inspection.sessionIsolationReady === true,
    configurationPinned: inspection.configurationPinned === true,
    stablePolicyPinned,
    configurationVersion: inspection.configurationVersion || null,
    configurationHash: inspection.configurationHash || null,
    subjectHash,
    trustSetHash: inspection.trustSetHash || null,
    signatureVerificationPolicyHash:
      inspection.signatureVerificationPolicyHash || null,
    fullProductionReady,
  });
}

export function inspectConfiguredAutonomousResearchCapabilityScope({
  environment,
  providerInspections,
  providerSpawnSync,
  researchAgendaProducerReceipt = null,
  clock = { now: () => new Date() },
  reviewerPreflight = undefined,
} = {}) {
  const empiricalFamilies = activeProductionEmpiricalFamilies();
  const contentMode = String(
    environment.HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE || 'deterministic-bounded',
  ).trim().toLowerCase();
  const machineGeneratedAgendaAuthorityReady = researchAgendaProducerReceipt !== null
    && verifyAutonomousResearchAgendaProductionReceipt(researchAgendaProducerReceipt).valid
    && JSON.stringify(researchAgendaProducerReceipt.allowedProtocolFamilies)
      === JSON.stringify(empiricalFamilies);
  const blockers = [];
  let reviewerPool = null;
  let reviewerPoolInspection = null;
  let priorArtRetriever = null;
  let externalReplay = null;
  let venueRegistry = null;
  let venueRegistryAuthority = null;
  let venueTemplateAssetBundle = null;
  let submissionPortal = null;
  let submissionMetadataProfile = null;
  let submissionMetadataAuthority = null;
  let venueComplianceRuntimeInspection = null;
  const inspect = (label, operation) => {
    try { return operation(); }
    catch (error) {
      blockers.push(`${label}:${String(error?.message || error)}`);
      return null;
    }
  };
  const authorIdentityAttestation = inspect('research-author-identity', () => (
    inspectAutonomousResearchAuthorRuntimeIdentity({
      environment,
      author: providerInspections?.researchAuthorPreflight || null,
      clock,
    })
  ));
  const authorIdentitySubjectHash = autonomousResearchAuthorIdentitySubjectHash(
    authorIdentityAttestation,
  );
  const authorIdentityInspection = authorIdentityTrustSurface(authorIdentityAttestation);
  const requiredOriginIdentitySubjectHashes = authorIdentitySubjectHash
    ? Object.freeze([authorIdentitySubjectHash]) : Object.freeze([]);
  const reviewerPoolConfigPath = String(
    environment.HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG || '',
  ).trim();
  if (reviewerPoolConfigPath && providerInspections?.researchAuthorPreflight) {
    reviewerPoolInspection = inspect('reviewer-principal-pool', () => (
      preflightReviewerPrincipalPool({
        configPath: reviewerPoolConfigPath,
        authorProvider: 'codex',
        authorCodexHome: providerInspections.researchAuthorPreflight.codexHome,
        environment,
        spawnSyncImpl: providerSpawnSync,
        authorIdentityAttestation,
        clock,
        ...(reviewerPreflight ? { preflightReviewer: reviewerPreflight } : {}),
      })
    ));
    reviewerPool = reviewerPoolInspection?.pool || null;
  } else if (reviewerPoolConfigPath) {
    blockers.push('reviewer-principal-pool:research-author-preflight-required');
  }
  const priorArtConfigPath = String(environment.HEPTA_PRIOR_ART_SERVICE_CONFIG || '').trim();
  const priorArtExpectedConfigurationHash = String(
    environment.HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH || '',
  ).trim().toLowerCase() || null;
  if (priorArtConfigPath) {
    priorArtRetriever = inspect('prior-art-service', () => createHttpPriorArtRetrievalAdapter({
      configuration: readPriorArtServiceConfiguration({
        configPath: priorArtConfigPath,
        expectedConfigurationHash: priorArtExpectedConfigurationHash,
      }),
      expectedConfigurationHash: priorArtExpectedConfigurationHash,
      environment,
      clock,
    }));
  }
  const externalReplayConfigPath = String(environment.HEPTA_EXTERNAL_REPLAY_CONFIG || '').trim();
  const externalReplayExpectedConfigurationHash = String(
    environment.HEPTA_EXTERNAL_REPLAY_CONFIG_HASH || '',
  ).trim().toLowerCase() || null;
  if (externalReplayConfigPath) {
    externalReplay = inspect('external-replay-service', () => createHttpExternalResearchReplayAdapter({
      configuration: readExternalResearchReplayServiceConfiguration({
        configPath: externalReplayConfigPath,
        expectedConfigurationHash: externalReplayExpectedConfigurationHash,
      }),
      expectedConfigurationHash: externalReplayExpectedConfigurationHash,
      environment,
      requiredLocalOriginIdentitySubjectHashes: requiredOriginIdentitySubjectHashes,
      clock,
    }));
  }
  const venueConfigPath = String(
    environment.HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG || '',
  ).trim();
  if (venueConfigPath) {
    const configured = inspect(
      'venue-profile-registry',
      () => readAutonomousVenueProfileRegistry({
        configPath: venueConfigPath,
        expectedConfigurationHash: String(
          environment.HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH || '',
        ).trim() || null,
      }),
    );
    ({
      registry: venueRegistry,
      authority: venueRegistryAuthority,
      templateAssetBundle: venueTemplateAssetBundle,
    } =
      venueConfiguration(configured));
  }
  const submissionConfigurationAvailable = Boolean(String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG || '',
  ).trim());
  if (submissionConfigurationAvailable) {
    submissionPortal = inspect('submission-portal-service', () => (
      createAutonomousSubmissionPortalDescriptor({
        configuration:
          readConfiguredAutonomousSubmissionPortalDescriptorConfiguration({
            environment,
            allowPrivateConfigurationFallback: false,
          }),
        expectedConfigurationHash: String(
          environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH || '',
        ).trim() || null,
        expectedDescriptorHash: String(
          environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH || '',
        ).trim() || null,
        requiredLocalOriginIdentitySubjectHashes: requiredOriginIdentitySubjectHashes,
        clock,
      })
    ));
  }
  const submissionMetadataConfigPath = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG || '',
  ).trim();
  if (submissionMetadataConfigPath) {
    const configured = inspect('submission-metadata-profile', () => (
      readAutonomousSubmissionMetadataProfile({
        configPath: submissionMetadataConfigPath,
        expectedConfigurationHash: String(
          environment.HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH || '',
        ).trim() || null,
      })
    ));
    ({ profile: submissionMetadataProfile, authority: submissionMetadataAuthority } =
      metadataConfiguration(configured));
  }
  const reviewerPrincipalCount = reviewerPool?.reviewerPrincipalCount || 1;
  const reviewerTrustDomainCount = reviewerPool?.reviewerTrustDomainCount || 1;
  const reviewerSessionTrustSurface = reviewerPoolInspection
    ? reviewerTrustSurface(reviewerPoolInspection)
    : isolatedReviewerSessionTrustSurface({
      author: providerInspections?.researchAuthorPreflight,
      reviewer: providerInspections?.formalReviewPreflight,
    });
  const externalSubmissionProfiles = venueRegistry?.profiles?.some((profile) => (
    profile.externalSubmissionEnabled
  )) === true;
  const venueTemplateAssetSupplyReady = venueTemplateAssetsReady(
    venueRegistry,
    venueTemplateAssetBundle,
  );
  if (externalSubmissionProfiles && !venueTemplateAssetSupplyReady) {
    blockers.push('venue-profile-template-assets:required');
  }
  if (authorIdentitySubjectHash && externalReplay
    && !localOriginIdentitySubjectHashes(externalReplay).includes(authorIdentitySubjectHash)) {
    blockers.push('external-replay-service:author-identity-binding-required');
  }
  if (authorIdentitySubjectHash && submissionPortal
    && !localOriginIdentitySubjectHashes(submissionPortal).includes(authorIdentitySubjectHash)) {
    blockers.push('submission-portal-service:author-identity-binding-required');
  }
  if (externalSubmissionProfiles && submissionPortal && submissionMetadataProfile) {
    venueComplianceRuntimeInspection = inspect(
      'venue-compliance-runtime',
      () => inspectLocalAutonomousVenueComplianceRuntime({
        spawnSyncImpl: providerSpawnSync,
      }),
    );
  }
  const externalCapabilityTrustInspection =
    buildAutonomousResearchExternalCapabilityTrustInspection({
      priorArt: priorArtRetriever,
      reviewerPool: reviewerSessionTrustSurface,
      externalReplay,
      submissionPortal,
    });
  const reviewerReceiptVerificationAuthority = reviewerPoolInspection
    ? inspect('reviewer-receipt-verification-authority', () => (
      createReviewerReceiptVerificationAuthority({
        pool: reviewerPoolInspection.pool,
        signers: new Map(reviewerPoolInspection.entries.map((entry) => (
          [entry.descriptor.principalId, entry.signer]
        ))),
        trustInspection: reviewerPoolInspection.trustInspection,
      })
    )) : null;
  const manifest = buildAutonomousResearchCapabilityScopeManifest({
    // Static configuration inspection cannot stand in for a signed, budget-bound
    // production receipt. Runtime preparation upgrades this only after the agent runs.
    agendaMode: machineGeneratedAgendaAuthorityReady
      ? 'machine-generated' : 'registered-profile',
    manuscriptMode: contentMode === 'agent-evidence-bound'
      ? 'agent-authored-evidence-bound-ir-v1'
      : 'minimal-report-evidence-bound-ir-v1',
    formalClaimClasses: ['1', 'true', 'yes'].includes(String(
      environment.HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED || '',
    ).trim().toLowerCase())
      ? ['registered-template-v1', 'dynamic-lean-type-v1']
      : ['registered-template-v1'],
    empiricalFamilies,
    priorArtMode: configuredPriorArtMode(priorArtRetriever),
    reviewerPrincipalCount,
    reviewerTrustDomainCount,
    replayMode: externalReplay
      ? 'external-trust-domain-v1' : 'same-process-recomputation-v1',
    venueMode: venueRegistry && submissionPortal && submissionMetadataProfile
      && signedConfigurationReady(venueRegistryAuthority)
      && signedConfigurationReady(submissionMetadataAuthority)
      && venueTemplateAssetSupplyReady
      && venueComplianceRuntimeInspection?.ready === true
      && venueRegistry.profiles.some((profile) => (
        profile.externalSubmissionEnabled
          && profile.bibliographyStyle === 'inline-evidence-v1'
          && profile.citationStyle === 'evidence-inline-v1'
      ))
      ? 'submission-enabled-v1'
      : venueRegistry ? 'profile-selected-v1' : 'disabled',
    externalPrerequisites: [
      ...(contentMode === 'agent-evidence-bound' && !machineGeneratedAgendaAuthorityReady
        ? ['machine-generated-agenda-receipt'] : []),
      ...(!priorArtRetriever ? ['prior-art-service'] : []),
      ...(!externalReplay ? ['external-replay-service'] : []),
      ...(!venueRegistry ? ['venue-profile-registry'] : []),
      ...(contentMode === 'agent-evidence-bound'
        && !signedConfigurationReady(venueRegistryAuthority)
        ? ['signed-venue-profile-registry'] : []),
      ...(contentMode === 'agent-evidence-bound'
        && !signedConfigurationReady(submissionMetadataAuthority)
        ? ['signed-submission-metadata-profile'] : []),
      ...(reviewerSessionTrustSurface?.identityIndependenceReady === true
        ? [] : ['independent-reviewer-session-isolation']),
      ...(externalSubmissionProfiles && !submissionPortal
        ? ['submission-portal-service'] : []),
      ...(externalSubmissionProfiles && !submissionMetadataProfile
        ? ['submission-metadata-profile'] : []),
      ...(externalSubmissionProfiles && !venueTemplateAssetSupplyReady
        ? ['venue-template-assets'] : []),
      ...(externalSubmissionProfiles && venueComplianceRuntimeInspection?.ready !== true
        ? ['venue-compliance-runtime'] : []),
      ...(venueRegistry?.profiles?.some((profile) => (
        profile.externalSubmissionEnabled
          && (profile.bibliographyStyle !== 'inline-evidence-v1'
            || profile.citationStyle !== 'evidence-inline-v1')
      )) ? ['venue-rendering-profile'] : []),
      ...(contentMode === 'agent-evidence-bound'
        ? externalCapabilityTrustInspection.blockers : []),
    ],
  });
  return Object.freeze({
    manifest,
    empiricalFamilies,
    blockers: Object.freeze(blockers),
    authorIdentityAttestationReady: authorIdentityAttestation?.ready === true,
    authorIdentityCryptographicAuthorityReady:
      authorIdentityInspection?.cryptographicAuthorityReady === true,
    authorIdentityFullProductionReady:
      authorIdentityInspection?.fullProductionReady === true,
    authorIdentityAttestation: authorIdentityInspection,
    authorIdentitySubjectHash,
    reviewerPrincipalPoolHash: reviewerPool?.researchPrincipalPoolHash || null,
    priorArtServiceConfigured: Boolean(priorArtRetriever),
    priorArtServiceConfigurationPinned:
      priorArtRetriever?.configurationPinned === true,
    priorArtServiceFullProductionReady:
      priorArtRetriever?.fullProductionReady === true,
    priorArtServiceConfigurationHash:
      priorArtRetriever?.configurationHash || null,
    priorArtAuthorityTrustConfiguration:
      priorArtRetriever?.cryptographicAuthorityReady === true
        ? priorArtRetriever.authorityTrustConfiguration() : null,
    externalReplayServiceConfigured: Boolean(externalReplay),
    externalReplayServiceConfigurationPinned:
      externalReplay?.configurationPinned === true,
    externalReplayServiceCrashRecoveryReady:
      externalReplay?.crashRecoveryReady === true,
    externalReplayServiceFullProductionReady:
      externalReplay?.fullProductionReady === true,
    externalResearchReplayReceiptVerifier:
      externalReplayReceiptVerificationSurface(externalReplay?.receiptVerifier),
    externalResearchReplayConfigurationHash:
      externalReplay?.configurationHash || null,
    reviewerReceiptVerificationAuthority,
    venueProfileRegistryConfigured: Boolean(venueRegistry),
    venueProfileRegistryAuthorityReady: signedConfigurationReady(venueRegistryAuthority),
    venueProfileRegistryHash:
      venueRegistry?.autonomousVenueProfileRegistryHash || null,
    venueProfileRegistryAuthorityConfigurationHash:
      signedConfigurationReady(venueRegistryAuthority)
        ? venueRegistryAuthority.configurationHash : null,
    venueTemplateAssetSupplyReady,
    venueTemplateAssetBundleHash:
      venueTemplateAssetBundle?.autonomousVenueTemplateAssetBundleHash || null,
    venueTemplateAssetCount: venueTemplateAssetBundle?.assetCount || 0,
    submissionMetadataAuthorityReady: signedConfigurationReady(submissionMetadataAuthority),
    submissionMetadataAuthorityConfigurationHash:
      signedConfigurationReady(submissionMetadataAuthority)
        ? submissionMetadataAuthority.configurationHash : null,
    submissionPortalConfigured: Boolean(submissionPortal),
    submissionPortalIdempotencyLookupSupported:
      submissionPortal?.idempotencyLookupSupported === true,
    autonomousSubmissionDurableOutboxRequired: Boolean(submissionPortal),
    submissionMetadataProfileConfigured: Boolean(submissionMetadataProfile),
    submissionMetadataProfileHash: submissionMetadataProfile?.profileHash || null,
    venueComplianceRuntimeReady: venueComplianceRuntimeInspection?.ready === true,
    venueComplianceRuntimeInspection,
    externalCapabilityTrustInspection,
  });
}

export function composeAutonomousResearchExternalCapabilities({
  paperId,
  requestedContentMode,
  dynamicFormalClaimsEnabled,
  reviewerPrincipalPoolInspection = null,
  venueProfileRegistry = null,
  venueProfileRegistryAuthority = null,
  venueTemplateAssetBundle = null,
  submissionMetadataProfile = null,
  submissionMetadataAuthority = null,
  priorArtRetriever = null,
  externalResearchReplay = null,
  autonomousSubmissionPortal = null,
  autonomousSubmissionRequestVerifier = null,
  requestedProtocolFamily = null,
  authorIdentityAttestation = null,
  environment = process.env,
  spawnSyncImpl = undefined,
  clock = { now: () => new Date() },
} = {}) {
  const blockers = [];
  let effectiveVenueProfileRegistry = venueProfileRegistry;
  let effectiveVenueProfileRegistryAuthority = venueProfileRegistryAuthority;
  let effectiveVenueTemplateAssetBundle = venueTemplateAssetBundle
    || venueProfileRegistryAuthority?.templateAssetBundle || null;
  let effectiveSubmissionMetadataProfile = submissionMetadataProfile;
  let effectiveSubmissionMetadataAuthority = submissionMetadataAuthority;
  let effectivePriorArtRetriever = priorArtRetriever;
  let effectiveExternalResearchReplay = externalResearchReplay;
  let effectiveAutonomousSubmissionPortal = autonomousSubmissionPortal;
  const authorIdentitySubjectHash = autonomousResearchAuthorIdentitySubjectHash(
    authorIdentityAttestation,
  );
  const requiredOriginIdentitySubjectHashes = authorIdentitySubjectHash
    ? Object.freeze([authorIdentitySubjectHash]) : Object.freeze([]);
  const externalReplayConfigPath = String(
    environment.HEPTA_EXTERNAL_REPLAY_CONFIG || '',
  ).trim();
  const externalReplayExpectedConfigurationHash = String(
    environment.HEPTA_EXTERNAL_REPLAY_CONFIG_HASH || '',
  ).trim().toLowerCase() || null;
  if (!effectiveExternalResearchReplay && externalReplayConfigPath) {
    try {
      effectiveExternalResearchReplay = createHttpExternalResearchReplayAdapter({
        configuration: readExternalResearchReplayServiceConfiguration({
          configPath: externalReplayConfigPath,
          expectedConfigurationHash: externalReplayExpectedConfigurationHash,
        }),
        expectedConfigurationHash: externalReplayExpectedConfigurationHash,
        environment,
        requiredLocalOriginIdentitySubjectHashes: requiredOriginIdentitySubjectHashes,
        clock,
      });
    } catch (error) {
      blockers.push(`autonomous_research_external_replay_invalid:${errorCode(error)}`);
    }
  }
  const priorArtConfigPath = String(
    environment.HEPTA_PRIOR_ART_SERVICE_CONFIG || '',
  ).trim();
  const priorArtExpectedConfigurationHash = String(
    environment.HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH || '',
  ).trim().toLowerCase() || null;
  if (!effectivePriorArtRetriever && priorArtConfigPath) {
    try {
      effectivePriorArtRetriever = createHttpPriorArtRetrievalAdapter({
        configuration: readPriorArtServiceConfiguration({
          configPath: priorArtConfigPath,
          expectedConfigurationHash: priorArtExpectedConfigurationHash,
        }),
        expectedConfigurationHash: priorArtExpectedConfigurationHash,
        environment,
        clock,
      });
    } catch (error) {
      blockers.push(`autonomous_research_prior_art_service_invalid:${errorCode(error)}`);
    }
  }
  const venueProfileConfigPath = String(
    environment.HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG || '',
  ).trim();
  if (!effectiveVenueProfileRegistry && venueProfileConfigPath) {
    try {
      const configured = readAutonomousVenueProfileRegistry({
        configPath: venueProfileConfigPath,
        expectedConfigurationHash: String(
          environment.HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH || '',
        ).trim() || null,
      });
      ({
        registry: effectiveVenueProfileRegistry,
        authority: effectiveVenueProfileRegistryAuthority,
        templateAssetBundle: effectiveVenueTemplateAssetBundle,
      } = venueConfiguration(configured));
    } catch (error) {
      blockers.push(`autonomous_research_venue_profile_invalid:${errorCode(error)}`);
    }
  }
  const submissionMetadataConfigPath = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG || '',
  ).trim();
  if (!effectiveSubmissionMetadataProfile && submissionMetadataConfigPath) {
    try {
      const configured = readAutonomousSubmissionMetadataProfile({
        configPath: submissionMetadataConfigPath,
        expectedConfigurationHash: String(
          environment.HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH || '',
        ).trim() || null,
      });
      ({ profile: effectiveSubmissionMetadataProfile,
        authority: effectiveSubmissionMetadataAuthority } = metadataConfiguration(configured));
    } catch (error) {
      blockers.push(`autonomous_research_submission_metadata_invalid:${errorCode(error)}`);
    }
  }
  const submissionPortalConfigurationAvailable = Boolean(String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG || '',
  ).trim());
  if (!effectiveAutonomousSubmissionPortal && submissionPortalConfigurationAvailable) {
    try {
      effectiveAutonomousSubmissionPortal = createAutonomousSubmissionPortalDescriptor({
        configuration:
          readConfiguredAutonomousSubmissionPortalDescriptorConfiguration({
            environment,
            allowPrivateConfigurationFallback: false,
          }),
        expectedConfigurationHash: String(
          environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH || '',
        ).trim() || null,
        expectedDescriptorHash: String(
          environment.HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH || '',
        ).trim() || null,
        requiredLocalOriginIdentitySubjectHashes: requiredOriginIdentitySubjectHashes,
        clock,
      });
    } catch (error) {
      blockers.push(`autonomous_research_submission_portal_invalid:${errorCode(error)}`);
    }
  }
  if (effectiveAutonomousSubmissionPortal
    && effectiveAutonomousSubmissionPortal.idempotencyLookupSupported !== true) {
    blockers.push(
      'autonomous_research_submission_portal_idempotency_lookup_required',
    );
  }
  if (authorIdentitySubjectHash && effectiveExternalResearchReplay
    && !localOriginIdentitySubjectHashes(effectiveExternalResearchReplay)
      .includes(authorIdentitySubjectHash)) {
    blockers.push('autonomous_research_external_replay_author_identity_binding_required');
  }
  if (authorIdentitySubjectHash && effectiveAutonomousSubmissionPortal
    && !localOriginIdentitySubjectHashes(effectiveAutonomousSubmissionPortal)
      .includes(authorIdentitySubjectHash)) {
    blockers.push('autonomous_research_submission_portal_author_identity_binding_required');
  }
  const trustedSubmissionRequests = submissionRequestVerifierReady(
    autonomousSubmissionRequestVerifier,
  );
  if (effectiveAutonomousSubmissionPortal && !trustedSubmissionRequests) {
    blockers.push('autonomous_research_submission_request_verifier_required');
  }
  const externalSubmissionProfiles = effectiveVenueProfileRegistry?.profiles?.some((profile) => (
    profile.externalSubmissionEnabled
  )) === true;
  const venueTemplateAssetSupplyReady = venueTemplateAssetsReady(
    effectiveVenueProfileRegistry,
    effectiveVenueTemplateAssetBundle,
  );
  if (externalSubmissionProfiles && !venueTemplateAssetSupplyReady) {
    blockers.push('autonomous_research_venue_template_assets_required');
  }
  let venueComplianceRuntimeInspection = null;
  if (externalSubmissionProfiles && effectiveAutonomousSubmissionPortal
    && effectiveSubmissionMetadataProfile) {
    try {
      venueComplianceRuntimeInspection = inspectLocalAutonomousVenueComplianceRuntime({
        ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
      });
      blockers.push(...venueComplianceRuntimeInspection.blockers);
    } catch (error) {
      blockers.push(`autonomous_research_venue_compliance_runtime_invalid:${errorCode(error)}`);
    }
  }
  if (dynamicFormalClaimsEnabled && requestedContentMode !== 'agent-evidence-bound') {
    blockers.push('autonomous_research_dynamic_formal_claims_require_agent_content');
  }
  const externalCapabilityTrustInspection =
    buildAutonomousResearchExternalCapabilityTrustInspection({
      priorArt: effectivePriorArtRetriever,
      reviewerPool: reviewerTrustSurface(reviewerPrincipalPoolInspection),
      externalReplay: effectiveExternalResearchReplay,
      submissionPortal: effectiveAutonomousSubmissionPortal,
    });
  const empiricalFamilies = activeProductionEmpiricalFamilies();
  const contentCapabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    scopeId: `hepta.autonomous-research.content.${paperId}`,
    agendaMode: requestedContentMode === 'agent-evidence-bound'
      ? 'machine-generated' : 'registered-profile',
    manuscriptMode: requestedContentMode === 'agent-evidence-bound'
      ? 'agent-authored-evidence-bound-ir-v1'
      : 'minimal-report-evidence-bound-ir-v1',
    formalClaimClasses: dynamicFormalClaimsEnabled
      ? ['dynamic-lean-type-v1', 'registered-template-v1']
      : ['registered-template-v1'],
    empiricalFamilies,
    priorArtMode: configuredPriorArtMode(effectivePriorArtRetriever),
    reviewerPrincipalCount:
      reviewerPrincipalPoolInspection?.pool.reviewerPrincipalCount || 1,
    reviewerTrustDomainCount:
      reviewerPrincipalPoolInspection?.pool.reviewerTrustDomainCount || 1,
    replayMode: effectiveExternalResearchReplay
      ? 'external-trust-domain-v1' : 'same-process-recomputation-v1',
    venueMode: effectiveVenueProfileRegistry && effectiveAutonomousSubmissionPortal
      && trustedSubmissionRequests
      && effectiveSubmissionMetadataProfile
      && signedConfigurationReady(effectiveVenueProfileRegistryAuthority)
      && signedConfigurationReady(effectiveSubmissionMetadataAuthority)
      && venueTemplateAssetSupplyReady
      && venueComplianceRuntimeInspection?.ready === true
      && effectiveVenueProfileRegistry.profiles.some((profile) => (
        profile.externalSubmissionEnabled
        && profile.bibliographyStyle === 'inline-evidence-v1'
        && profile.citationStyle === 'evidence-inline-v1'
      ))
      ? 'submission-enabled-v1'
      : effectiveVenueProfileRegistry ? 'profile-selected-v1' : 'disabled',
    externalPrerequisites: Object.freeze([
      ...(!effectivePriorArtRetriever ? ['structured-prior-art-service'] : []),
      ...(reviewerPrincipalPoolInspection?.identityIndependenceReady === true
        && (reviewerPrincipalPoolInspection?.cryptographicAuthorityReady === true
          || reviewerPrincipalPoolInspection?.sessionIsolationReady === true)
        ? [] : ['independent-reviewer-session-isolation']),
      ...(!effectiveExternalResearchReplay ? ['external-replay-service'] : []),
      ...(!effectiveVenueProfileRegistry ? ['venue-profile-registry'] : []),
      ...(requestedContentMode === 'agent-evidence-bound'
        && !signedConfigurationReady(effectiveVenueProfileRegistryAuthority)
        ? ['signed-venue-profile-registry'] : []),
      ...(requestedContentMode === 'agent-evidence-bound'
        && !signedConfigurationReady(effectiveSubmissionMetadataAuthority)
        ? ['signed-submission-metadata-profile'] : []),
      ...(effectiveVenueProfileRegistry?.profiles.some((profile) => (
        profile.externalSubmissionEnabled
      )) && !effectiveAutonomousSubmissionPortal
        ? ['submission-portal-service'] : []),
      ...(effectiveVenueProfileRegistry?.profiles.some((profile) => (
        profile.externalSubmissionEnabled
      )) && !effectiveSubmissionMetadataProfile
        ? ['submission-metadata-profile'] : []),
      ...(externalSubmissionProfiles && !venueTemplateAssetSupplyReady
        ? ['venue-template-assets'] : []),
      ...(externalSubmissionProfiles && effectiveAutonomousSubmissionPortal
        && !trustedSubmissionRequests ? ['submission-request-verifier'] : []),
      ...(externalSubmissionProfiles && venueComplianceRuntimeInspection?.ready !== true
        ? ['venue-compliance-runtime'] : []),
      ...(effectiveVenueProfileRegistry?.profiles.some((profile) => (
        profile.externalSubmissionEnabled
          && (profile.bibliographyStyle !== 'inline-evidence-v1'
            || profile.citationStyle !== 'evidence-inline-v1')
      )) ? ['venue-rendering-profile'] : []),
      ...(requestedContentMode === 'agent-evidence-bound'
        ? externalCapabilityTrustInspection.blockers : []),
    ]),
  });
  const capabilityRequestCoverage = evaluateAutonomousResearchCapabilityRequestCoverage({
    manifest: contentCapabilityScopeManifest,
    requestedProtocolFamily,
  });
  blockers.push(...capabilityRequestCoverage.blockers);
  return Object.freeze({
    blockers: Object.freeze(blockers),
    effectiveVenueProfileRegistry,
    effectiveVenueProfileRegistryAuthority,
    effectiveVenueTemplateAssetBundle,
    effectiveSubmissionMetadataProfile,
    effectiveSubmissionMetadataAuthority,
    effectivePriorArtRetriever,
    effectiveExternalResearchReplay,
    effectiveAutonomousSubmissionPortal,
    venueComplianceRuntimeInspection,
    contentCapabilityScopeManifest,
    capabilityRequestCoverage,
    empiricalFamilies,
    externalCapabilityTrustInspection,
  });
}
