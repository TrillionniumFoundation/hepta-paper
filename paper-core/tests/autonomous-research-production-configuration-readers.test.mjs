import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  composeAutonomousResearchMachineIntakeEnqueue,
} from '../../paper-composition/automation/autonomous-research-machine-intake-enqueue-composition.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  buildAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';

import {
  buildAutonomousSubmissionMetadataProfile,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  buildAutonomousVenueProfile,
  buildAutonomousVenueProfileRegistry,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  readAutonomousSubmissionMetadataProfile,
} from '../../paper-adapters/automation/autonomous-submission-metadata-profile-reader.mjs';
import {
  readAutonomousVenueProfileRegistry,
} from '../../paper-adapters/automation/autonomous-venue-profile-registry-reader.mjs';
import {
  buildReviewerReceiptSignerServiceConfiguration,
} from '../../paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs';
import {
  buildReviewerPrincipalPoolConfiguration,
  readReviewerPrincipalPoolConfiguration,
  verifyReviewerPrincipalPoolConfiguration,
} from '../../paper-adapters/automation/reviewer-principal-pool-configuration-reader.mjs';
import {
  composeReviewerPrincipalExecutorPool,
  preflightReviewerPrincipalPool,
} from '../../paper-composition/automation/reviewer-principal-pool-composition.mjs';
import {
  resolveAutonomousResearchCampaignSubmission,
} from '../../paper-application/automation/autonomous-research-campaign-submission.mjs';
import {
  assertAutonomousResearchOnlineAuthorityEvidenceCacheReaderPort,
  assertAutonomousResearchOnlineAuthorityEvidenceCacheWriterPort,
  assertAutonomousResearchOnlineAuthorityJournalInstallerPort,
  assertAutonomousResearchOnlineAuthorityJournalReaderPort,
  assertAutonomousResearchOnlineAuthorityJournalWriterPort,
  assertExternallyFencedSqliteMutationCoordinatorPort,
} from '../../paper-ports/autonomous-research-online-mutation-port.mjs';
import {
  composeAutonomousResearchOnlineFinalizedDatabaseHeadInspection,
  composeAutonomousResearchOnlineMutationCoordinator,
  composeAutonomousResearchOnlineMutationDatabaseStartupReconciliation,
  composeAutonomousResearchOnlineMutationRuntimeActivation,
} from '../../paper-composition/bootstrap/autonomous-research-online-mutation-composition.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS,
} from '../../paper-composition/bootstrap/autonomous-research-online-mutation-operation-plans.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-authority.mjs';
import {
  fileSha256HashSync,
} from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  preparedSqliteReceiptLedgerMutation,
} from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  leanTypeIdentity,
  normalizeLeanType,
} from '../../paper-domain/research/lean-type-identity.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const digest = (label) => hashRecord('ProductionConfigurationReaderFixture', { label });

function writeJson(candidate, value) {
  fs.writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function schemaTransitionAuthorityProcessConfiguration(root) {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(root, 'online-authority-public-key.json');
  const authorityConfigurationPath = path.join(root, 'online-authority.json');
  const processConfigurationPath = path.join(root, 'online-authority-process.json');
  writeJson(publicKeyPath, {
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityPublicKey',
    authorityId: 'authority:configuration-test',
    keyId: 'key:configuration-test',
    algorithm: 'ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  writeJson(authorityConfigurationPath, {
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityConfiguration',
    authorityId: 'authority:configuration-test',
    keyId: 'key:configuration-test',
    scopeId: 'scope:configuration-test',
    databaseScopeHash: digest('schema-transition-database-scope'),
    writerManifestHash: digest('schema-transition-writer-manifest'),
    publicKeyPath,
    publicKeySha256: fileSha256HashSync(publicKeyPath),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  });
  writeJson(processConfigurationPath, {
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',
    authorityConfigurationPath,
    authorityConfigurationSha256: fileSha256HashSync(authorityConfigurationPath),
    commandPath: process.execPath,
    commandSha256: fileSha256HashSync(process.execPath),
    fixedArguments: [],
    timeoutMs: 5_000,
  });
  return processConfigurationPath;
}

function metadataProfile() {
  return buildAutonomousSubmissionMetadataProfile({
    profileId: 'machine-author-profile-v1',
    authors: [{
      authorId: 'machine-author',
      displayName: 'Machine Author',
      affiliations: ['Machine Research Laboratory'],
      orcid: '0000-0002-1825-0097',
      correspondingAuthor: true,
    }],
    defaultKeywords: ['autonomous research', 'evidence binding'],
    conflictOfInterestStatement: 'No competing interests.',
    fundingStatement: 'No external funding.',
    dataAvailabilityStatement: 'Bound data are included in the evidence capsule.',
    codeAvailabilityStatement: 'Bound source is included in the release archive.',
    profileAuthorityReceiptHash: digest('metadata-authority'),
  });
}

function venueRegistry() {
  return buildAutonomousVenueProfileRegistry({
    registryId: 'machine-venue-registry-v1',
    profiles: [buildAutonomousVenueProfile({
      venueId: 'machine-research-journal',
      displayName: 'Machine Research Journal',
      protocolFamilies: ['ml_algorithm_benchmark'],
      acceptedPaperTypes: ['research_article'],
      documentClass: 'article',
      bibliographyStyle: 'inline-evidence-v1',
      citationStyle: 'evidence-inline-v1',
      maximumPages: 12,
      requiredMetadata: [
        'title', 'abstract', 'authors', 'keywords', 'conflict_of_interest',
        'funding', 'data_availability', 'code_availability',
      ],
      submissionPortalProfileId: 'machine-research-article-v1',
      externalSubmissionEnabled: true,
      profileAuthorityReceiptHash: digest('venue-authority'),
    })],
  });
}

function signerConfiguration(index) {
  return buildReviewerReceiptSignerServiceConfiguration({
    serviceId: `reviewer-signer-${index}`,
    endpoint: `https://reviewer-${index}.example.test/v1/sign`,
    serviceIdentityHash: digest(`signer-service-${index}`),
    signerIdentityHash: digest(`signer-${index}`),
    tokenEnvironmentVariable: `REVIEWER_SIGNER_TOKEN_${index}`,
    timeoutMs: 5_000,
  });
}

function reviewerPoolConfiguration(root) {
  return buildReviewerPrincipalPoolConfiguration({
    poolId: 'production-reviewers-v1',
    minimumReviewerTrustDomains: 2,
    principals: [1, 2].map((index) => ({
      codexBinary: '/usr/bin/true',
      codexHome: path.join(root, `reviewer-home-${index}`),
      model: `review-model-${index}`,
      providerAccountIdentityHash: digest(`provider-account-${index}`),
      roles: index === 1
        ? ['formal-review', 'independent-review']
        : ['independent-review'],
      signerConfiguration: signerConfiguration(index),
      trustDomainIdentityHash: digest(`trust-domain-${index}`),
    })),
  });
}

function reviewerPreflight({ codexHome, model }) {
  const index = path.basename(codexHome).endsWith('-1') ? 1 : 2;
  const payload = {
    version: 1,
    kind: 'CodexFormalReviewerCapabilityReceipt',
    status: 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model,
    codexVersion: 'codex-test-v1',
    codexBinaryIdentityHash: digest('codex-binary'),
    credentialRootIdentityHash: digest(`credential-root-${index}`),
    credentialConfigIdentityHash: digest(`credential-config-${index}`),
    authorCredentialRootIdentityHash: digest('author-credential-root'),
    authenticationStatus: 'codex_authentication_verified',
    modelOptionVerified: true,
    selectedModelExecutionCanaryVerified: false,
    readOnlyReviewRequired: true,
    dynamicAttemptWorkspaceRequired: true,
    credentialIndependenceVerified: true,
    providerCredentialSharingPermitted: true,
    freshEphemeralSessionRequired: true,
    authorContextInheritanceForbidden: true,
    frozenArtifactReviewRequired: true,
    reviewerMustDifferFromAuthorPrincipal: true,
    assuranceScope: 'ephemeral_session_frozen_artifact_and_role_separation',
    providerAccountIndependenceVerified: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    codexBinary: '/usr/bin/true',
    codexHome,
    effectivePrincipalId: `reviewer-principal-${index}`,
    capabilityReceipt: Object.freeze({
      ...payload,
      codexFormalReviewerCapabilityReceiptHash:
        hashRecord('CodexFormalReviewerCapabilityReceipt', payload),
    }),
  });
}

test('production metadata and venue readers accept only verified regular JSON files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-production-readers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadataPath = path.join(root, 'metadata.json');
  const venuePath = path.join(root, 'venues.json');
  writeJson(metadataPath, metadataProfile());
  writeJson(venuePath, venueRegistry());

  assert.deepEqual(
    readAutonomousSubmissionMetadataProfile({ configPath: metadataPath }),
    metadataProfile(),
  );
  assert.deepEqual(
    readAutonomousVenueProfileRegistry({ configPath: venuePath }),
    venueRegistry(),
  );

  writeJson(metadataPath, { ...metadataProfile(), profileHash: digest('tampered') });
  assert.throws(
    () => readAutonomousSubmissionMetadataProfile({ configPath: metadataPath }),
    /autonomous_submission_metadata_profile_verification_failed/,
  );
  fs.writeFileSync(venuePath, '{broken json', { mode: 0o600 });
  assert.throws(
    () => readAutonomousVenueProfileRegistry({ configPath: venuePath }),
    /autonomous_venue_profile_registry_config_invalid/,
  );
  assert.throws(
    () => readAutonomousSubmissionMetadataProfile({ configPath: root }),
    /autonomous_submission_metadata_profile_config_invalid/,
  );
  assert.throws(
    () => readAutonomousVenueProfileRegistry({ configPath: path.join(root, 'missing') }),
    /autonomous_venue_profile_registry_config_invalid/,
  );
});

test('reviewer pool reader and composition bind independent principals and signers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-reviewer-pool-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'reviewer-home-1'), { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'reviewer-home-2'), { mode: 0o700 });
  const configuration = reviewerPoolConfiguration(root);
  const configPath = path.join(root, 'reviewers.json');
  writeJson(configPath, configuration);
  assert.equal(verifyReviewerPrincipalPoolConfiguration(configuration), true);
  assert.deepEqual(readReviewerPrincipalPoolConfiguration({ configPath }), configuration);

  const environment = {
    REVIEWER_SIGNER_TOKEN_1: 'test-token-1',
    REVIEWER_SIGNER_TOKEN_2: 'test-token-2',
  };
  const preflight = preflightReviewerPrincipalPool({
    configPath,
    authorProvider: 'openai',
    authorCodexHome: path.join(root, 'author-home'),
    environment,
    preflightReviewer: reviewerPreflight,
    fetchImpl: async () => { throw new Error('network_not_expected'); },
  });
  assert.equal(preflight.pool.status, 'research_principal_pool_ready');
  assert.equal(preflight.pool.reviewerTrustDomainCount, 2);
  assert.equal(preflight.entries.length, 2);

  const composed = composeReviewerPrincipalExecutorPool({
    configPath,
    authorProvider: 'openai',
    authorCodexHome: path.join(root, 'author-home'),
    runtimeRoot: root,
    environment,
    preflightReviewer: reviewerPreflight,
    fetchImpl: async () => { throw new Error('network_not_expected'); },
  });
  assert.equal(composed.executorPool.kind, 'ReviewerPrincipalExecutorPool');
  assert.equal(composed.executorPool.pool.reviewerProviderAccountCount, 2);

  const duplicate = configuration.principals.map((principal, index) => ({
    ...principal,
    providerAccountIdentityHash:
      configuration.principals[0].providerAccountIdentityHash,
    roles: index === 0 ? ['formal-review', 'independent-review'] : ['independent-review'],
  }));
  assert.throws(() => buildReviewerPrincipalPoolConfiguration({
    poolId: 'duplicate-reviewers',
    principals: duplicate,
    minimumReviewerTrustDomains: 2,
  }), /reviewer_principal_pool_configuration_independence_invalid/);
  assert.equal(verifyReviewerPrincipalPoolConfiguration({ ...configuration, extra: true }), false);
  writeJson(configPath, { ...configuration, configurationHash: digest('tampered') });
  assert.throws(
    () => readReviewerPrincipalPoolConfiguration({ configPath }),
    /reviewer_principal_pool_configuration_verification_failed/,
  );
  assert.throws(
    () => composeReviewerPrincipalExecutorPool({ configPath, runtimeRoot: null }),
    /reviewer_principal_pool_runtime_root_required/,
  );
});

test('campaign status treats a required but absent autonomous submission as pending', async () => {
  const outbox = Object.freeze({
    kind: 'AutonomousSubmissionOutboxPort',
    durability: 'sqlite-transactional-outbox-v1',
    singleUseDispatchCapabilityIssued: true,
    externallyFencedMutations: false,
    prepareAutonomousSubmission() { throw new Error('write_not_expected'); },
    beginAutonomousSubmissionAttempt() { throw new Error('write_not_expected'); },
    recordAutonomousSubmissionOutcome() { throw new Error('write_not_expected'); },
    getAutonomousSubmission() { return null; },
    listAutonomousSubmissionsForCampaign() { return []; },
  });
  const verifier = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionRequestVerifier',
    verify() { return true; },
  });
  const resolved = await resolveAutonomousResearchCampaignSubmission({
    action: 'status',
    campaign: { paperId: 'paper-status-1', status: 'completed' },
    campaignId: 'campaign-status-1',
    preparation: {
      autonomousSubmissionPortalConfigurationHash: digest('portal-config'),
      venueProfileSelection: {
        profile: { externalSubmissionEnabled: true },
        requireExternalSubmission: true,
      },
    },
    qualificationEligibility: {
      campaignFullyQualified: true,
      fullAutomaticResearchWritingReady: true,
    },
    autonomousSubmissionPortal: { portalId: 'status-only-portal' },
    autonomousSubmissionOutbox: outbox,
    autonomousSubmissionRequestVerifier: verifier,
  });
  assert.equal(resolved.submissionRequired, true);
  assert.equal(resolved.submissionReady, false);
  assert.equal(resolved.fullAutomaticResearchWritingReady, false);
  assert.equal(
    resolved.campaignExecutionStatus,
    'autonomous_research_campaign_completed_submission_pending',
  );
});

test('campaign submission resolution covers local completion and fails closed before handoff', async () => {
  const portalConfigurationHash = digest('portal-config');
  const metadataReceiptHash = digest('metadata-receipt');
  const preparation = {
    autonomousSubmissionPortalConfigurationHash: portalConfigurationHash,
    submissionMetadataReceipt: {
      autonomousSubmissionMetadataReceiptHash: metadataReceiptHash,
    },
    venueProfileSelection: {
      venueId: 'machine-research-journal',
      profile: {
        externalSubmissionEnabled: true,
        submissionPortalProfileId: 'machine-research-article-v1',
      },
      requireExternalSubmission: true,
    },
  };
  const campaign = { paperId: 'paper-submit-coverage', status: 'completed' };
  const local = await resolveAutonomousResearchCampaignSubmission({
    action: 'execute',
    campaign,
    campaignId: 'campaign-submit-coverage',
    preparation,
    campaignReleaseAuthority: {},
    qualificationEligibility: { campaignFullyQualified: false },
    localOnly: true,
  });
  assert.equal(local.submissionRequired, false);
  assert.equal(local.localResearchWritingReady, true);
  assert.equal(
    local.campaignExecutionStatus,
    'autonomous_research_campaign_completed_local',
  );

  const common = {
    action: 'execute',
    campaign,
    campaignId: 'campaign-submit-coverage',
    preparation,
    campaignReleaseAuthority: {},
    qualificationEligibility: { campaignFullyQualified: true },
  };
  await assert.rejects(
    () => resolveAutonomousResearchCampaignSubmission(common),
    /autonomous_submission_portal_descriptor_required/,
  );
  await assert.rejects(
    () => resolveAutonomousResearchCampaignSubmission({
      ...common,
      autonomousSubmissionPortal: {
        kind: 'AutonomousSubmissionPortalDescriptor',
        portalId: 'machine-portal',
        configurationHash: portalConfigurationHash,
      },
      autonomousVenueComplianceInspector: {
        kind: 'AutonomousVenueComplianceInspector',
        async inspect() {
          return { submissionMetadataReceiptHash: metadataReceiptHash };
        },
      },
      autonomousSubmissionRequestVerifier: {
        kind: 'AutonomousSubmissionRequestVerifier',
        verify() { return true; },
      },
    }),
    /autonomous_submission_human_authorization_verifier_required/,
  );
});

test('online mutation ports reject every missing trust-boundary method', () => {
  const cases = [
    [assertAutonomousResearchOnlineAuthorityJournalInstallerPort,
      'installAuthorityJournalSchema'],
    [assertAutonomousResearchOnlineAuthorityJournalReaderPort,
      'readPassiveAuthorityEvidence'],
    [assertAutonomousResearchOnlineAuthorityJournalWriterPort,
      'recordActiveAuthorityEvidence'],
    [assertAutonomousResearchOnlineAuthorityEvidenceCacheReaderPort,
      'readPassiveAuthorityEvidence'],
    [assertAutonomousResearchOnlineAuthorityEvidenceCacheWriterPort,
      'recordActiveAuthorityEvidence'],
  ];
  for (const [assertPort, method] of cases) {
    const port = { [method]() {} };
    assert.equal(assertPort(port), port);
    assert.throws(() => assertPort({}), new RegExp(method));
  }
  const coordinator = {
    executeMutation() {},
    recoverPendingMutations() {},
    inspectStatus() {},
  };
  assert.equal(assertExternallyFencedSqliteMutationCoordinatorPort(coordinator), coordinator);
  for (const method of Object.keys(coordinator)) {
    const incomplete = { ...coordinator };
    delete incomplete[method];
    assert.throws(
      () => assertExternallyFencedSqliteMutationCoordinatorPort(incomplete),
      new RegExp(method),
    );
  }
  assert.throws(
    () => preparedSqliteReceiptLedgerMutation({}),
    /receipt_ledger_prepared_mutation_invalid/,
  );
});

test('online mutation composition binds the canonical manifest before downstream I/O', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-composition-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST;
  const trust = Object.freeze({
    scopeId: 'production-online-scope',
    databaseScopeHash: digest('online-database-scope'),
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(manifest),
    maximumReservationLeaseMs: 60_000,
  });
  const authorityClient = Object.freeze({
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    trust,
    observeCurrentHead() { throw new Error('database_io_not_expected'); },
    reserveMutation() { throw new Error('database_io_not_expected'); },
    verifyStoredReservation() { return false; },
    finalizeMutation() { throw new Error('database_io_not_expected'); },
    abortMutation() { throw new Error('database_io_not_expected'); },
    resolveMutationAttempt() { throw new Error('database_io_not_expected'); },
  });
  const inventory = Object.freeze({
    status: 'autonomous_research_state_database_inventory_ready',
    inventoryHash: digest('online-inventory'),
    databaseScopeHash: trust.databaseScopeHash,
    instances: Object.freeze(manifest.coverage.coveredDatabaseRoles.map((role, index) => (
      Object.freeze({
        role,
        instanceId: `${role}:fixture-${index + 1}`,
        schemaHash: digest(`schema:${role}`),
      })
    ))),
  });
  const createAuthorityClient = ({ processConfigurationPath }) => {
    assert.equal(processConfigurationPath, '/authority/process.json');
    return authorityClient;
  };
  const coordinator = composeAutonomousResearchOnlineMutationCoordinator({
    inventory,
    authorityProcessConfigurationPath: '/authority/process.json',
    manifest,
    operationPlans: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS,
    createAuthorityClient,
  });
  assert.equal(
    coordinator.inspectStatus().status,
    'externally_fenced_sqlite_mutation_coordinator_configured',
  );

  assert.throws(() => composeAutonomousResearchOnlineMutationDatabaseStartupReconciliation({
    database: {},
    databaseRole: inventory.instances[0].role,
    databaseInstanceId: inventory.instances[0].instanceId,
    authorityProcessConfigurationPath: '/authority/process.json',
    manifest,
    createAuthorityClient,
  }));
  assert.throws(() => composeAutonomousResearchOnlineFinalizedDatabaseHeadInspection({
    database: {},
    databaseInstanceId: inventory.instances[0].instanceId,
    inventory,
    authorityProcessConfigurationPath: '/authority/process.json',
    manifest,
    createAuthorityClient,
  }));
  assert.throws(() => composeAutonomousResearchOnlineMutationRuntimeActivation({
    workspaceRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'),
    runtimeRoot,
    inventory,
    latestRestoreDrill: null,
    resolveInventory: async () => inventory,
    authorityProcessConfigurationPath: '/authority/process.json',
    authorityConfigurationPath: '/authority/trust.json',
    manifest,
    operationPlans: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS,
    createAuthorityClient,
  }));

  assert.throws(
    () => composeAutonomousResearchOnlineMutationCoordinator({}),
    /autonomous_research_online_mutation_composition_prerequisites_missing/,
  );
  assert.throws(
    () => composeAutonomousResearchOnlineMutationDatabaseStartupReconciliation({}),
    /autonomous_research_online_mutation_composition_prerequisites_missing/,
  );
  assert.throws(
    () => composeAutonomousResearchOnlineFinalizedDatabaseHeadInspection({}),
    /autonomous_research_online_mutation_composition_prerequisites_missing/,
  );
  assert.throws(
    () => composeAutonomousResearchOnlineMutationRuntimeActivation({}),
    /autonomous_research_online_mutation_composition_prerequisites_missing/,
  );
});

test('schema-transition process client pins authority and command identities before requests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-schema-authority-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processConfigurationPath = schemaTransitionAuthorityProcessConfiguration(root);
  const client = createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient({
    processConfigurationPath,
  });
  assert.equal(client.trust.authorityId, 'authority:configuration-test');
  assert.match(client.configurationHash, /^sha256:[0-9a-f]{64}$/);
  assert.throws(
    () => client.reserveSchemaTransition({ request: {}, now: new Date() }),
    /autonomous_research_online_schema_transition_reserve_request_invalid/,
  );
  assert.throws(
    () => client.verifyStoredReservation({ receipt: {}, request: {}, now: new Date() }),
    /autonomous_research_online_schema_transition_reserve_request_invalid/,
  );
  assert.throws(
    () => client.finalizeSchemaTransition({ request: {}, reservation: {}, now: new Date() }),
    /autonomous_research_online_schema_transition_finalize_request_invalid/,
  );
  assert.throws(
    () => client.observeSchemaTransition({ request: {}, now: new Date() }),
    /autonomous_research_online_schema_transition_observe_request_invalid/,
  );

  const configuration = JSON.parse(fs.readFileSync(processConfigurationPath, 'utf8'));
  configuration.commandSha256 = digest('tampered-command');
  writeJson(processConfigurationPath, configuration);
  assert.throws(
    () => createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient({
      processConfigurationPath,
    }),
    /autonomous_research_online_schema_transition_process_identity_mismatch/,
  );
});

test('Lean type identity removes only balanced outer wrappers and canonicalizes arrows', () => {
  assert.equal(normalizeLeanType(' (((Nat  ->  Nat))) '), 'Nat→Nat');
  assert.equal(normalizeLeanType('(Nat) -> Nat'), '(Nat)→Nat');
  assert.equal(leanTypeIdentity(':').normalizedTypeHash, null);
  assert.match(
    leanTypeIdentity(': Nat -> Nat').normalizedTypeHash,
    /^sha256:[0-9a-f]{64}$/,
  );
});

test('machine-intake enqueue fails before provider work on invalid clocks, aborts, and trust configuration', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-machine-intake-enqueue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(runtimeRoot);
  const environment = {
    HEPTA_RESEARCH_AUTHOR_CODEX_HOME: path.join(root, 'author-home'),
    HEPTA_RESEARCH_AUTHOR_MODEL: 'fixture-author-model',
    HEPTA_FORMAL_REVIEW_CODEX_HOME: path.join(root, 'reviewer-home'),
    HEPTA_FORMAL_REVIEW_MODEL: 'fixture-reviewer-model',
  };
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    environment,
  });
  const intake = buildAutonomousResearchMachineIntake({
    intakeId: 'intake:enqueue-coverage',
    paperId: 'paper-enqueue-coverage',
    campaignId: 'autonomous-research:paper-enqueue-coverage',
    launchMode: 'production-run',
    objective: 'Evaluate a signed machine-proposed hypothesis without runtime human approval.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [{
      name: 'enqueue-coverage-dataset',
      source: path.join(root, 'dataset'),
      readOnly: true,
      manifestHash: digest('enqueue-coverage-dataset'),
      licenseId: 'CC0-1.0',
      benchmarkFamily: 'ml_algorithm_benchmark',
    }],
    budgets: {
      maxWallTimeMs: 3_600_000,
      maxAgentCalls: 10,
      maxCpuJobs: 10,
      maxGpuJobs: 0,
      maxTokenCount: 10_000,
      maxCostUsd: 10,
      maxMemoryMiB: 2048,
    },
    providerConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    revisionRounds: 1,
    refereeCount: 2,
    admissionCreatedAt: '2026-07-19T01:00:00.000Z',
  });
  const machineIntakeAdmission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind: 'machine',
    sourceAuthorityHash: digest('enqueue-coverage-source-authority'),
  });

  await assert.rejects(
    () => composeAutonomousResearchMachineIntakeEnqueue({ intake: null }),
    /autonomous_research_machine_intake_invalid/,
  );
  await assert.rejects(
    () => composeAutonomousResearchMachineIntakeEnqueue({
      intake,
      machineIntakeAdmission,
      clock: { now: () => new Date('invalid') },
    }),
    /autonomous_research_machine_intake_clock_invalid/,
  );
  await assert.rejects(
    () => composeAutonomousResearchMachineIntakeEnqueue({
      intake,
      machineIntakeAdmission,
      runtimeSignal: { aborted: true, reason: 'fixture_runtime_abort' },
    }),
    /fixture_runtime_abort/,
  );

  const fenceActions = [];
  await assert.rejects(
    () => composeAutonomousResearchMachineIntakeEnqueue({
      intake,
      machineIntakeAdmission,
      root,
      runtimeRoot,
      environment,
      intakeLeaseRepository: {
        assertIntakeLease() {},
        renewIntakeLease() { return true; },
      },
      intakeLease: { leaseId: 'fixture-lease' },
      residentLeaseContext: { leaseId: 'fixture-resident-lease' },
      assertAutonomyCurrent({ action }) {
        fenceActions.push(action);
        return { ready: true, operationMode: 'full' };
      },
      admissionSpawnSyncImpl: () => ({ status: 1, stdout: '', stderr: '' }),
      now: new Date('2026-07-19T01:01:00.000Z'),
    }),
  );
  assert.deepEqual(fenceActions, [
    'before_admission_preflight',
    'before_dataset_authority_read',
    'before_admission_readiness',
  ]);
});
