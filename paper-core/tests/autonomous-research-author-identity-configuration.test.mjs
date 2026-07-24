import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAutonomousResearchAuthorIdentityConfiguration,
  inspectAutonomousResearchAuthorIdentity,
  readAutonomousResearchAuthorIdentityConfiguration,
} from '../../paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  composeAutonomousResearchReadiness,
} from '../../paper-composition/automation/autonomous-research-readiness-composition.mjs';
import {
  composeAutonomousResearchExternalCapabilities,
} from '../../paper-composition/automation/autonomous-research-external-capability-composition.mjs';
import {
  inspectAutonomousResearchRuntimePrincipals,
} from '../../paper-composition/automation/autonomous-research-runtime-principal-preflight.mjs';
import {
  composeCampaignWorkerExecution,
} from '../../paper-composition/automation/campaign-worker-composition.mjs';
import {
  createAgentResearchAgendaProducer,
} from '../../paper-adapters/automation/agent-research-agenda-producer.mjs';
import {
  createAgentResearchContentProducer,
} from '../../paper-adapters/automation/agent-research-content-producer.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  buildAutonomousResearchRuntimePrincipalBinding,
  verifyAutonomousResearchRuntimePrincipalBinding,
} from '../../paper-domain/automation/autonomous-research-runtime-principal-binding-contract.mjs';
import {
  buildAutonomousResearchAgentProductionAuthorityBinding,
} from '../../paper-domain/automation/autonomous-research-agent-production-authority-binding.mjs';
import {
  buildAutonomousResearchAgendaProductionReceipt,
  buildAutonomousResearchAgendaProductionRequest,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  selectMachineGeneratedAutonomousResearchAgenda,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  buildResearchPrincipalDescriptor,
  buildResearchPrincipalPool,
} from '../../paper-domain/research/research-principal-pool-contract.mjs';
import {
  buildAutonomousVenueProfile,
  buildAutonomousVenueProfileRegistry,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  buildAutonomousSubmissionMetadataProfile,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  buildAutonomousConfigurationAuthorityProof,
  autonomousConfigurationAuthoritySigningPayload,
} from '../../paper-domain/automation/autonomous-configuration-authority-contract.mjs';
import {
  productionPriorArtAuthorityFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-19T02:00:00.000Z');
const ROLE = 'external_principal_identity_attestor';
const H = (label) => hashRecord('AutonomousResearchAuthorIdentityTest', { label });

function signedEnvelope(pair, subject) {
  const unsigned = buildPinnedExternalEvidenceEnvelope({
    subjectKind: subject.kind,
    subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
    signedAt: '2026-07-19T01:59:00.000Z',
    expiresAt: '2026-07-19T02:01:00.000Z',
    signatures: [{
      keyId: 'author-identity-key', role: ROLE, algorithm: 'ed25519', value: 'placeholder',
    }],
  });
  const value = crypto.sign(
    null,
    pinnedExternalEvidenceSigningPayload(unsigned),
    pair.privateKey,
  ).toString('base64');
  return buildPinnedExternalEvidenceEnvelope({
    ...unsigned,
    signatures: [{
      keyId: 'author-identity-key', role: ROLE, algorithm: 'ed25519', value,
    }],
  });
}

function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const credentialRootIdentityHash = H('author-credential-root');
  const principalId = 'codex-research-author:fixture';
  const subject = buildExternalPrincipalIdentityAttestationSubject({
    serviceId: 'codex-author-provider',
    principalId,
    provider: 'openai',
    providerAccountIdentityHash: H('author-provider-account'),
    credentialRootIdentityHash,
    hostIdentityHash: H('author-host'),
    processIdentityHash: H('author-process'),
    trustDomainIdentityHash: H('author-trust-domain'),
    signerPublicKeySpkiHash: H('author-provider-signer'),
    challengeHash: H('author-identity-challenge'),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: '2026-07-19T01:58:00.000Z',
    expiresAt: '2026-07-19T02:02:00.000Z',
  });
  const trustStore = Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [Object.freeze({
      keyId: 'author-identity-key',
      subjectId: 'author-identity-attestor',
      organization: 'Independent Identity Authority',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [ROLE],
      status: 'active',
      effectiveFrom: '2026-07-19T00:00:00.000Z',
      expiresAt: '2026-07-20T00:00:00.000Z',
      revokedAt: null,
    })],
  });
  const configuration = buildAutonomousResearchAuthorIdentityConfiguration({
    subject,
    authorityEnvelope: signedEnvelope(pair, subject),
    trustStore,
    signerKeyIds: ['author-identity-key'],
    maximumLifetimeMs: 5 * 60 * 1000,
  });
  const author = Object.freeze({
    effectivePrincipalId: principalId,
    capabilityReceipt: Object.freeze({
      provider: 'openai',
      credentialRootIdentityHash,
    }),
  });
  return { pair, subject, configuration, author };
}

function writeConfiguration(root, name, configuration) {
  const configPath = path.join(root, name);
  fs.writeFileSync(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  return configPath;
}

function capability(kind, hashField, payload) {
  return Object.freeze({
    ...payload,
    [hashField]: hashRecord(kind, payload),
  });
}

function reviewerPoolFixture(authorCredentialRootIdentityHash) {
  const descriptors = [1, 2, 3].map((ordinal) => buildResearchPrincipalDescriptor({
    principalId: `reviewer-${ordinal}`,
    roles: ordinal === 1 ? ['formal-review', 'independent-review'] : ['independent-review'],
    provider: 'openai',
    modelIdentityHash: H(`reviewer-${ordinal}:model`),
    providerAccountIdentityHash: H(`reviewer-${ordinal}:account`),
    credentialRootIdentityHash: H(`reviewer-${ordinal}:credential`),
    credentialConfigIdentityHash: H(`reviewer-${ordinal}:config`),
    trustDomainIdentityHash: H(`reviewer-${ordinal}:domain`),
    capabilityReceiptHash: H(`reviewer-${ordinal}:capability`),
    signerIdentityHash: H(`reviewer-${ordinal}:signer`),
  }));
  const pool = buildResearchPrincipalPool({
    poolId: 'author-identity-composition-reviewers',
    principals: descriptors,
    minimumReviewerTrustDomains: 3,
  });
  const reviewerPayload = {
    version: 1,
    kind: 'CodexFormalReviewerCapabilityReceipt',
    status: 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model: 'reviewer-model',
    credentialRootIdentityHash: descriptors[0].credentialRootIdentityHash,
    credentialConfigIdentityHash: descriptors[0].credentialConfigIdentityHash,
    authorCredentialRootIdentityHash,
    credentialIndependenceVerified: true,
    assuranceScope: 'configured_principal_and_process_separation',
  };
  const reviewerCapability = capability(
    'CodexFormalReviewerCapabilityReceipt',
    'codexFormalReviewerCapabilityReceiptHash',
    reviewerPayload,
  );
  return Object.freeze({
    pool,
    entries: Object.freeze([Object.freeze({
      descriptor: descriptors[0],
      preflight: Object.freeze({
        effectivePrincipalId: descriptors[0].principalId,
        capabilityReceipt: reviewerCapability,
      }),
    })]),
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    trustSetHash: H('reviewer-pool:trust-set'),
    signatureVerificationPolicyHash: H('reviewer-pool:signature-policy'),
  });
}

function signedConfigurationProof({ subjectKind, subjectHash, role, observedAt }) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyId = `${role}-key`;
  const trustStore = Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [Object.freeze({
      keyId,
      subjectId: `${role}-subject`,
      organization: 'Configuration Authority',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [role],
      status: 'active',
    })],
  });
  const observedAtMs = Date.parse(observedAt);
  const unsigned = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt: new Date(observedAtMs - 60_000).toISOString(),
    expiresAt: new Date(observedAtMs + 60 * 60_000).toISOString(),
    signatures: [{ keyId, role, algorithm: 'ed25519', value: 'placeholder' }],
  });
  const value = crypto.sign(
    null,
    autonomousConfigurationAuthoritySigningPayload(unsigned),
    pair.privateKey,
  ).toString('base64');
  return buildAutonomousConfigurationAuthorityProof({
    subjectKind,
    subjectHash,
    requiredRole: role,
    trustStore,
    authorityEnvelope: buildPinnedExternalEvidenceEnvelope({
      ...unsigned,
      signatures: [{ keyId, role, algorithm: 'ed25519', value }],
    }),
    expectedKeyIds: [keyId],
    maximumLifetimeMs: 2 * 60 * 60_000,
  }, { observedAt });
}

function verifiedConfiguration(kind, value, authorityProof) {
  return Object.freeze({
    version: 2,
    kind,
    ...value,
    authorityProof,
    configurationHash: authorityProof.configurationHash,
    configurationPinned: true,
    cryptographicAuthorityReady: true,
    trustSetHash: authorityProof.trustSetHash,
    signatureVerificationPolicyHash: authorityProof.signatureVerificationPolicyHash,
  });
}

function venueFixtures(protocolFamily, observedAt) {
  const profile = buildAutonomousVenueProfile({
    venueId: 'author-identity-test-venue',
    displayName: 'Author Identity Test Venue',
    protocolFamilies: [protocolFamily],
    documentClass: 'article',
    bibliographyStyle: 'inline-evidence-v1',
    citationStyle: 'evidence-inline-v1',
    maximumPages: 20,
    requiredMetadata: [
      'title', 'abstract', 'authors', 'keywords', 'conflict_of_interest',
      'funding', 'data_availability', 'code_availability',
    ],
    submissionPortalProfileId: 'author-identity-test-v1',
    externalSubmissionEnabled: true,
    profileAuthorityReceiptHash: H('venue-authority'),
    scopeTerms: [protocolFamily.replace(/_/g, ' '), 'bounded algorithm evidence'],
  });
  const registry = buildAutonomousVenueProfileRegistry({
      registryId: 'author-identity-test-venues',
      profiles: [profile],
    });
  const metadata = buildAutonomousSubmissionMetadataProfile({
      profileId: 'author-identity-test-metadata',
      authors: [{
        authorId: 'autonomous-author',
        displayName: 'Autonomous Author',
        affiliations: ['Autonomous Research Lab'],
        orcid: null,
        correspondingAuthor: true,
      }],
      defaultKeywords: ['autonomous research'],
      conflictOfInterestStatement: 'No competing interests.',
      fundingStatement: 'No external funding.',
      dataAvailabilityStatement: 'Evidence is bound in the release capsule.',
      codeAvailabilityStatement: 'Source is bound in the release capsule.',
      profileAuthorityReceiptHash: H('metadata-authority'),
    });
  const venueProof = signedConfigurationProof({
    subjectKind: 'AutonomousVenueProfileRegistry',
    subjectHash: registry.autonomousVenueProfileRegistryHash,
    role: 'venue_profile_authority',
    observedAt,
  });
  const metadataProof = signedConfigurationProof({
    subjectKind: 'AutonomousSubmissionMetadataProfile',
    subjectHash: metadata.profileHash,
    role: 'submission_metadata_authority',
    observedAt,
  });
  return Object.freeze({
    registry,
    metadata,
    registryAuthority: verifiedConfiguration(
      'VerifiedAutonomousVenueProfileRegistryConfiguration', { registry }, venueProof,
    ),
    metadataAuthority: verifiedConfiguration(
      'VerifiedAutonomousSubmissionMetadataProfileConfiguration', { profile: metadata },
      metadataProof,
    ),
  });
}

function runtimeToolPreflight(command, args = []) {
  if (command === 'bwrap' || command === '/usr/bin/true') {
    return Object.freeze({ status: 1, signal: null, stdout: '', stderr: 'fixture-bwrap-unavailable' });
  }
  if (command === 'which') {
    return Object.freeze({ status: 0, signal: null, stdout: '/usr/bin/true\n', stderr: '' });
  }
  if (command === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
    return Object.freeze({
      status: 0,
      signal: null,
      stdout: JSON.stringify([{
        Descriptor: {
          digest: `sha256:${'d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc'}`,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
        },
        Os: 'linux',
        Architecture: 'amd64',
      }]),
      stderr: '',
    });
  }
  if (command === 'docker' && args[0] === 'info') {
    return Object.freeze({ status: 0, signal: null, stdout: 'fixture-docker\n', stderr: '' });
  }
  throw new Error(`unexpected_spawn:${command}`);
}

test('author identity configuration is pinned, file-safe, and bound to the live author', () => {
  const selected = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-author-identity-'));
  const configPath = path.join(root, 'author-identity.json');
  fs.writeFileSync(configPath, `${JSON.stringify(selected.configuration)}\n`, { mode: 0o600 });
  try {
    const configuration = readAutonomousResearchAuthorIdentityConfiguration({ configPath });
    const inspection = inspectAutonomousResearchAuthorIdentity({
      configuration,
      author: selected.author,
      now: NOW,
      expectedConfigurationHash: configuration.configurationHash,
    });
    assert.equal(inspection.ready, true);
    assert.equal(inspection.cryptographicAuthorityReady, true);
    assert.equal(inspection.subject, configuration.subject);
    assert.deepEqual(inspection.verificationReceipt.verifiedKeyIds, ['author-identity-key']);
    assert.equal(
      inspection.verificationReceipt.verifiedPublicKeySpkiHashes[0],
      hashBytes(selected.pair.publicKey.export({ type: 'spki', format: 'der' })),
    );

    assert.throws(() => inspectAutonomousResearchAuthorIdentity({
      configuration,
      author: {
        ...selected.author,
        capabilityReceipt: {
          ...selected.author.capabilityReceipt,
          credentialRootIdentityHash: H('different-credential-root'),
        },
      },
      now: NOW,
      expectedConfigurationHash: configuration.configurationHash,
    }), /author_identity_binding_invalid/);

    fs.chmodSync(configPath, 0o666);
    assert.throws(
      () => readAutonomousResearchAuthorIdentityConfiguration({ configPath }),
      /configuration_file_invalid/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('author identity rejects expiry, trust substitution, and a symlinked config', () => {
  const selected = fixture();
  assert.throws(() => inspectAutonomousResearchAuthorIdentity({
    configuration: selected.configuration,
    author: selected.author,
    now: new Date('2026-07-19T02:03:00.000Z'),
    expectedConfigurationHash: selected.configuration.configurationHash,
  }), /author_identity_binding_invalid/);

  const attacker = fixture();
  const substitutedTrust = buildAutonomousResearchAuthorIdentityConfiguration({
    ...selected.configuration,
    trustStore: attacker.configuration.trustStore,
  });
  assert.throws(() => inspectAutonomousResearchAuthorIdentity({
    configuration: substitutedTrust,
    author: selected.author,
    now: NOW,
    expectedConfigurationHash: substitutedTrust.configurationHash,
  }), /pinned_external_evidence_verification_capability_invalid/);

  assert.throws(() => inspectAutonomousResearchAuthorIdentity({
    configuration: attacker.configuration,
    author: attacker.author,
    now: NOW,
    expectedConfigurationHash: selected.configuration.configurationHash,
  }), /configuration_pin_mismatch/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-author-identity-link-'));
  const real = path.join(root, 'real.json');
  const link = path.join(root, 'link.json');
  fs.writeFileSync(real, `${JSON.stringify(selected.configuration)}\n`, { mode: 0o600 });
  fs.symlinkSync(real, link);
  try {
    assert.throws(
      () => readAutonomousResearchAuthorIdentityConfiguration({ configPath: link }),
      /configuration_file_invalid/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production composition shares one pinned author identity with reviewer and preparation', async (t) => {
  const observedAt = NOW.toISOString();
  const paperId = 'author-identity-production-composition';
  const objective = 'Evaluate a bounded algorithm with independently signed evidence.';
  const protocolFamily = 'ml_algorithm_benchmark';
  const empiricalFamilies = [...AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES].sort();
  const preliminaryAgendaRequest = buildAutonomousResearchAgendaProductionRequest({
    paperId,
    objectiveHint: objective,
    protocolFamilyHint: protocolFamily,
    allowedProtocolFamilies: empiricalFamilies,
  });
  const preliminaryAgendaAgentPayload = {
    status: 'agent_execution_completed',
    executorId: 'author-identity-agenda-executor',
    agentId: 'research-author-1',
    providerMode: 'configured-agent-provider',
    resolvedModel: 'pinned-author-model',
    promptHash: H('agenda-prompt'),
    changedPaths: [],
  };
  const preliminaryAgendaAgentReceipt = capability(
    'AgentExecutionReceipt', 'agentExecutionReceiptHash', preliminaryAgendaAgentPayload,
  );
  const preliminaryAgendaReceipt = buildAutonomousResearchAgendaProductionReceipt({
    request: preliminaryAgendaRequest,
    selectedObjective: objective,
    selectedProtocolFamily: protocolFamily,
    agentExecutionReceipt: preliminaryAgendaAgentReceipt,
    producerId: 'research-author-1',
    generatedAt: observedAt,
  });
  const preliminaryAgendaSelection = selectMachineGeneratedAutonomousResearchAgenda({
    paperId,
    researchAgendaProducerReceipt: preliminaryAgendaReceipt,
    selectedAt: observedAt,
  });
  let priorAuthority = productionPriorArtAuthorityFixture({
    paperId,
    agendaSelectionReceiptHash:
      preliminaryAgendaSelection.autonomousResearchAgendaSelectionReceiptHash,
    observedAt,
  });
  const authorSubject = priorAuthority.authorityBundle.generatorIdentityAttestation;
  const authorConfiguration = buildAutonomousResearchAuthorIdentityConfiguration({
    subject: authorSubject,
    authorityEnvelope: priorAuthority.authorityBundle.generatorIdentityEnvelope,
    trustStore: priorAuthority.trustConfiguration.identityTrustStore,
    signerKeyIds: priorAuthority.trustConfiguration.identitySignerKeyIds,
    maximumLifetimeMs: priorAuthority.trustConfiguration.identityMaximumLifetimeMs,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-author-composition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = writeConfiguration(root, 'author-identity.json', authorConfiguration);
  const authorPayload = {
    version: 1,
    kind: 'CodexResearchAuthorCapabilityReceipt',
    status: 'codex_research_author_capability_ready',
    provider: authorSubject.provider,
    model: 'pinned-author-model',
    credentialRootIdentityHash: authorSubject.credentialRootIdentityHash,
    credentialConfigIdentityHash: H('author-config'),
  };
  const author = Object.freeze({
    effectivePrincipalId: authorSubject.principalId,
    codexHome: '/fixture/author',
    capabilityReceipt: capability(
      'CodexResearchAuthorCapabilityReceipt',
      'codexResearchAuthorCapabilityReceiptHash',
      authorPayload,
    ),
  });
  const reviewerInspection = reviewerPoolFixture(
    author.capabilityReceipt.credentialRootIdentityHash,
  );
  let reviewerPreflightInput = null;
  const preflightReviewerPrincipalPool = (input) => {
    reviewerPreflightInput = input;
    return reviewerInspection;
  };
  let priorArtRetrieveInput = null;
  const priorArtRetriever = Object.freeze({
    version: 2,
    kind: 'PriorArtRetrievalPort',
    evidenceProfile: 'structured-ranked-deduplicated-v2',
    configurationHash: priorAuthority.authorityBundle.configurationHash,
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    trustSetHash: priorAuthority.trustConfiguration.trustSetHash,
    signatureVerificationPolicyHash:
      priorAuthority.trustConfiguration.signatureVerificationPolicyHash,
    authorityTrustConfigurationHash:
      priorAuthority.trustConfiguration.priorArtAuthorityTrustConfigurationHash,
    async retrieve(input) {
      priorArtRetrieveInput = input;
      return priorAuthority.priorArtReceipt;
    },
    verifyAuthority() { return priorAuthority.authorityBundle; },
    authorityFor() { return priorAuthority.authorityBundle; },
    verifyAuthorityBundle(receipt, bundle) {
      assert.equal(receipt, priorAuthority.priorArtReceipt);
      assert.equal(bundle, priorAuthority.authorityBundle);
      return bundle;
    },
    authorityTrustConfiguration() { return priorAuthority.trustConfiguration; },
  });
  const externalReplay = Object.freeze({
    configurationHash: H('external-replay-config'),
    identitySeparationInspection: Object.freeze({
      localOriginIdentitySubjects: Object.freeze([authorSubject]),
    }),
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    trustSetHash: H('external-replay-trust'),
    signatureVerificationPolicyHash: H('external-replay-policy'),
  });
  const submissionPortal = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionPortalPort',
    configurationHash: H('submission-portal-config'),
    idempotencyLookupSupported: true,
    identitySeparationInspection: Object.freeze({
      localOriginIdentitySubjects: Object.freeze([authorSubject]),
    }),
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    trustSetHash: H('submission-portal-trust'),
    signatureVerificationPolicyHash: H('submission-portal-policy'),
  });
  const submissionRequestVerifier = Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionRequestVerifier',
    verify: () => true,
  });
  const venue = venueFixtures(protocolFamily, observedAt);
  const external = composeAutonomousResearchExternalCapabilities({
    paperId,
    refereeCount: 3,
    requestedContentMode: 'agent-evidence-bound',
    dynamicFormalClaimsEnabled: true,
    reviewerPrincipalPoolInspection: reviewerInspection,
    venueProfileRegistry: venue.registry,
    venueProfileRegistryAuthority: venue.registryAuthority,
    submissionMetadataProfile: venue.metadata,
    submissionMetadataAuthority: venue.metadataAuthority,
    priorArtRetriever,
    externalResearchReplay: externalReplay,
    autonomousSubmissionPortal: submissionPortal,
    autonomousSubmissionRequestVerifier: submissionRequestVerifier,
    requestedProtocolFamily: protocolFamily,
    environment: {},
    spawnSyncImpl: runtimeToolPreflight,
  });
  assert.deepEqual(external.blockers, []);
  assert.deepEqual(external.contentCapabilityScopeManifest.empiricalFamilies, empiricalFamilies);
  const readinessEnvironment = {
    HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'agent-evidence-bound',
    HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED: '1',
    HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG: configPath,
    HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH: authorConfiguration.configurationHash,
    HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG: '/fixture/reviewer-pool.json',
    HEPTA_RESEARCH_AUTHOR_MODEL: 'pinned-author-model',
    HEPTA_FORMAL_REVIEW_MODEL: 'pinned-reviewer-model',
  };
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    environment: readinessEnvironment,
  });
  const runtimePrincipalBinding = buildAutonomousResearchRuntimePrincipalBinding({
    authorPrincipalId: author.effectivePrincipalId,
    authorIdentityConfigurationHash: authorConfiguration.configurationHash,
    authorIdentitySubjectHash:
      authorSubject.externalPrincipalIdentityAttestationSubjectHash,
    authorCapabilityReceiptHash:
      author.capabilityReceipt.codexResearchAuthorCapabilityReceiptHash,
    authorCredentialRootIdentityHash:
      author.capabilityReceipt.credentialRootIdentityHash,
    researchPrincipalPoolHash: reviewerInspection.pool.researchPrincipalPoolHash,
    reviewerTrustSetHash:
      external.externalCapabilityTrustInspection.components.reviewerPool.trustSetHash,
    reviewerSignatureVerificationPolicyHash:
      external.externalCapabilityTrustInspection.components.reviewerPool
        .signatureVerificationPolicyHash,
  });
  const productionAuthorityBinding =
    buildAutonomousResearchAgentProductionAuthorityBinding({
      runtimePrincipalBinding,
      autonomousResearchProviderConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      authorPrincipalId: author.effectivePrincipalId,
      authorProvider: author.capabilityReceipt.provider,
      authorModel: author.capabilityReceipt.model,
      authorCapabilityReceiptHash:
        author.capabilityReceipt.codexResearchAuthorCapabilityReceiptHash,
      authorCredentialRootIdentityHash:
        author.capabilityReceipt.credentialRootIdentityHash,
      authorCredentialConfigIdentityHash:
        author.capabilityReceipt.credentialConfigIdentityHash,
    });
  const producerWorkspace = path.join(root, 'producer-workspace');
  fs.mkdirSync(producerWorkspace);
  let agendaCalls = 0;
  let contentCalls = 0;
  const executorFor = (role) => {
    const executorId = `author-identity-${role}-executor`;
    return Object.freeze({
      version: 1,
      kind: 'AuthorIdentityProductionFixtureExecutor',
      executorId,
      capabilities: () => buildExecutorCapabilities({
        executorId,
        sandboxModes: ['read-only'],
        networkPolicy: 'none',
        receiptKinds: ['AgentExecutionReceipt'],
      }),
      async execute() {
        if (role === 'agenda') agendaCalls += 1;
        else contentCalls += 1;
        const structuredOutput = role === 'agenda' ? {
          status: 'completed',
          summary: 'Selected one bounded production agenda.',
          checksRun: ['schema', 'family-scope'],
          blockers: [],
          objective,
          protocolFamily,
          researchQuestion: 'Does the declared treatment improve the bounded score?',
          primaryClaim: 'The declared treatment improves a bounded score over control.',
          dataRequirements: {
            population: 'Signed registered benchmark cases.',
            intervention: 'Declared treatment algorithm.',
            comparator: 'Registered control algorithm.',
            estimand: 'Paired mean bounded-score difference.',
            requiredVariables: ['bounded_score', 'treatment_assignment'],
            datasetConstraints: ['Read-only signed benchmark mount.'],
          },
          falsifiers: ['A non-positive paired bounded-score difference.'],
          negativeBoundaries: ['No claim outside the signed benchmark population.'],
          formalTargets: ['Kernel-check the registered algorithm invariant.'],
          priorArtQueryPlan: ['evidence-bound autonomous research systems'],
          venueConstraints: {
            paperType: 'research_article',
            requiredSections: ['methods', 'results', 'limitations'],
            artifactRequired: true,
            anonymousReviewRequired: true,
          },
          resourceFeasibility: {
            maximumWallTimeMs: 3_600_000,
            maximumMemoryBytes: 8_589_934_592,
            maximumCpuCount: 4,
            executionEnvironment: 'signed-python-runtime-v1',
          },
        } : {
          status: 'completed',
          summary: 'Generated bounded production content and one formal support claim.',
          checksRun: ['schema', 'scope'],
          blockers: [],
          empiricalHypothesis: {
            statement: 'The declared treatment improves a bounded score over control.',
            assumptions: ['The registered benchmark cases are available.'],
            quantifiers: ['For every registered deterministic seed.'],
            negativeBoundaries: ['No open-world superiority or causal claim is made.'],
            empiricalObligations: [
              'Execute treatment, control, and ablation with fixed metrics.',
            ],
          },
          dynamicFormalClaim: {
            statement: 'Every natural number equals itself.',
            assumptions: ['The quantified value has type Nat.'],
            quantifiers: ['For every natural number n.'],
            negativeBoundaries: ['No empirical conclusion follows from this identity.'],
            proofObligations: ['Kernel replay verifies the exact normalized Lean type.'],
            leanDeclarationName: 'authorIdentityBoundIdentity',
            leanTypeSource: '∀ n : Nat, n = n',
            allowedImports: ['Mathlib'],
          },
        };
        const payload = {
          version: 1,
          kind: 'AgentExecutionReceipt',
          status: 'agent_execution_completed',
          executorId,
          agentId: productionAuthorityBinding.authorPrincipalId,
          providerMode: productionAuthorityBinding.authorProvider,
          resolvedModel: productionAuthorityBinding.authorModel,
          promptHash: H(`${role}-prompt`),
          changedPaths: [],
          structuredOutput,
          codexResearchAuthorCapabilityReceiptHash:
            productionAuthorityBinding.authorCapabilityReceiptHash,
          codexCredentialRootIdentityHash:
            productionAuthorityBinding.authorCredentialRootIdentityHash,
          codexCredentialConfigIdentityHash:
            productionAuthorityBinding.authorCredentialConfigIdentityHash,
        };
        return Object.freeze({
          ...payload,
          agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
        });
      },
    });
  };
  const researchAgendaProducer = createAgentResearchAgendaProducer({
    agentExecutor: executorFor('agenda'),
    workspacePath: producerWorkspace,
    cacheRoot: path.join(root, 'agenda-cache'),
    producerId: productionAuthorityBinding.authorPrincipalId,
    allowedProtocolFamilies: empiricalFamilies,
    productionAuthorityBinding,
    clock: { now: () => new Date(observedAt) },
  });
  const hypothesisGenerator = createAgentResearchContentProducer({
    agentExecutor: executorFor('content'),
    workspacePath: producerWorkspace,
    cacheRoot: path.join(root, 'content-cache'),
    producerId: productionAuthorityBinding.authorPrincipalId,
    allowedProtocolFamilies: empiricalFamilies,
    productionAuthorityBinding,
    dynamicFormalClaimsEnabled: true,
    capabilityScopeManifestHash:
      external.contentCapabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    clock: { now: () => new Date(observedAt) },
  });
  const producedAgenda = await researchAgendaProducer.produce({
    paperId,
    objectiveHint: objective,
    protocolFamilyHint: protocolFamily,
  });
  const agendaSelection = selectMachineGeneratedAutonomousResearchAgenda({
    paperId,
    researchAgendaProducerReceipt: producedAgenda.researchAgendaProducerReceipt,
    selectedAt: observedAt,
  });
  priorAuthority = productionPriorArtAuthorityFixture({
    paperId,
    agendaSelectionReceiptHash:
      agendaSelection.autonomousResearchAgendaSelectionReceiptHash,
    observedAt,
  });
  const report = await composeAutonomousResearchReadiness({
    paperId,
    objective,
    protocolFamily,
    launchMode: 'production-run',
    revisionRounds: 1,
    refereeCount: 3,
    researchAgendaProducer,
    hypothesisGenerator,
    venueProfileRegistry: venue.registry,
    venueProfileRegistryAuthority: venue.registryAuthority,
    submissionMetadataProfile: venue.metadata,
    submissionMetadataAuthority: venue.metadataAuthority,
    priorArtRetriever,
    externalResearchReplay: externalReplay,
    autonomousSubmissionPortal: submissionPortal,
    autonomousSubmissionRequestVerifier: submissionRequestVerifier,
    environment: readinessEnvironment,
    preflightAuthor: () => author,
    preflightReviewerPrincipalPool,
    preflightEmpiricalRuntime: () => null,
    spawnSyncImpl: runtimeToolPreflight,
    createdAt: observedAt,
  });
  assert.equal(report.loopPreparation.productionProfileInspection.ready, true);
  assert.equal(verifyAutonomousResearchRuntimePrincipalBinding(
    report.loopPreparation.runtimePrincipalBinding,
  ), true);
  assert.equal(report.loopPreparation.runtimePrincipalBinding
    .authorIdentityConfigurationHash, authorConfiguration.configurationHash);
  assert.equal(report.loopPreparation.runtimePrincipalBindingHash,
    report.loopPreparation.runtimePrincipalBinding.runtimePrincipalBindingHash);
  assert.deepEqual(report.loopPreparation.productionAuthorityBinding,
    productionAuthorityBinding);
  assert.equal(report.loopPreparation.productionAuthorityBindingHash,
    productionAuthorityBinding.autonomousResearchAgentProductionAuthorityBindingHash);
  assert.equal(agendaCalls, 1);
  assert.equal(contentCalls, 1);
  assert.equal(reviewerPreflightInput.authorIdentityAttestation.configurationPinned, true);
  assert.equal(
    reviewerPreflightInput.authorIdentityAttestation.subject,
    priorArtRetrieveInput.generatorIdentityAttestation,
  );
  assert.equal(
    reviewerPreflightInput.authorIdentityAttestation.authorityEnvelope,
    priorArtRetrieveInput.generatorIdentityAuthorityEnvelope,
  );
  assert.deepEqual(priorArtRetrieveInput.generatorIdentityAttestation, authorSubject);
});

test('strong composition blocks missing, expired, and substituted author trust before providers', async (t) => {
  const selected = fixture();
  const attacker = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-author-pre-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expiredPath = writeConfiguration(root, 'expired.json', selected.configuration);
  const attackerPath = writeConfiguration(root, 'attacker.json', attacker.configuration);
  const cases = [{
    label: 'missing',
    environment: {},
  }, {
    label: 'expired',
    environment: {
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG: expiredPath,
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH: selected.configuration.configurationHash,
    },
  }, {
    label: 'trust-substitution',
    environment: {
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG: attackerPath,
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH: selected.configuration.configurationHash,
    },
  }];
  for (const selectedCase of cases) {
    let agendaCalls = 0;
    let contentCalls = 0;
    await assert.rejects(() => composeAutonomousResearchReadiness({
      paperId: `author-pre-provider-${selectedCase.label}`,
      objective: 'This provider must never be called.',
      protocolFamily: 'ml_algorithm_benchmark',
      launchMode: 'production-run',
      researchAgendaProducer: {
        async produce() { agendaCalls += 1; throw new Error('provider_called'); },
      },
      hypothesisGenerator: {
        async generate() { contentCalls += 1; throw new Error('provider_called'); },
      },
      environment: {
        HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'agent-evidence-bound',
        HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED: '1',
        ...selectedCase.environment,
      },
      preflightAuthor: () => (selectedCase.label === 'trust-substitution'
        ? attacker.author : selected.author),
      preflightReviewer: () => Object.freeze({
        effectivePrincipalId: 'fixture-reviewer',
        capabilityReceipt: Object.freeze({}),
      }),
      preflightEmpiricalRuntime: () => null,
    }), /autonomous_research_production_preflight_blocked/);
    assert.equal(agendaCalls, 0, selectedCase.label);
    assert.equal(contentCalls, 0, selectedCase.label);
  }
});

test('runtime principal composition forwards the exact pinned inspection to the reviewer pool', () => {
  const selected = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-author-reviewer-wire-'));
  const configPath = writeConfiguration(root, 'author.json', selected.configuration);
  const reviewerInspection = reviewerPoolFixture(
    selected.author.capabilityReceipt.credentialRootIdentityHash,
  );
  let captured = null;
  let capturedClock = null;
  const inspectionClock = Object.freeze({ now: () => NOW });
  try {
    const inspection = inspectAutonomousResearchRuntimePrincipals({
      authorConfiguration: { provider: 'codex' },
      reviewerConfiguration: {},
      refereeCount: 3,
      environment: {
        HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG: configPath,
        HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH:
          selected.configuration.configurationHash,
        HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG: '/fixture/reviewer-pool.json',
      },
      preflightAuthor: () => selected.author,
      preflightEmpiricalRuntime: () => null,
      preflightReviewerPrincipalPool(input) {
        captured = input.authorIdentityAttestation;
        capturedClock = input.clock;
        return reviewerInspection;
      },
      clock: inspectionClock,
    });
    assert.equal(inspection.blockers.length, 0);
    assert.equal(captured, inspection.authorIdentityAttestation);
    assert.equal(captured.configurationPinned, true);
    assert.equal(captured.subject, inspection.authorIdentityAttestation.subject);
    assert.equal(captured.authorityEnvelope, inspection.authorIdentityAttestation.authorityEnvelope);
    assert.equal(capturedClock, inspectionClock);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('campaign worker revalidates and forwards the pinned author identity to the reviewer pool', (t) => {
  const selected = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-author-worker-wire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = writeConfiguration(root, 'author.json', selected.configuration);
  const model = 'pinned-author-model';
  const capabilityPayload = {
    version: 1,
    kind: 'CodexResearchAuthorCapabilityReceipt',
    status: 'codex_research_author_capability_ready',
    provider: 'openai',
    model,
    codexVersion: 'codex-worker-author-fixture',
    codexBinaryIdentityHash: H('worker-author-binary'),
    credentialRootIdentityHash:
      selected.author.capabilityReceipt.credentialRootIdentityHash,
    credentialConfigIdentityHash: H('worker-author-config'),
    authenticationStatus: 'codex_authentication_verified',
    selectedModelExecutionCanaryVerified: false,
    workspaceWriteRequired: true,
    dynamicAttemptWorkspaceRequired: true,
    assuranceScope:
      'filesystem_credential_root_runtime_and_model_selection_preflight',
    providerAccountIdentityAttested: false,
    externalActionPerformed: false,
  };
  const authorPreflight = Object.freeze({
    ...selected.author,
    codexBinary: '/usr/bin/true',
    codexHome: root,
    capabilityReceipt: Object.freeze({
      ...capabilityPayload,
      codexResearchAuthorCapabilityReceiptHash:
        hashRecord('CodexResearchAuthorCapabilityReceipt', capabilityPayload),
    }),
  });
  let reviewerPoolInput = null;
  const researchPrincipalPoolHash = H('worker-reviewer-pool');
  const reviewerTrustSetHash = H('worker-reviewer-trust-set');
  const reviewerSignatureVerificationPolicyHash = H('worker-reviewer-policy');
  const executorPool = Object.freeze({
    pool: Object.freeze({ researchPrincipalPoolHash }),
    trustSetHash: reviewerTrustSetHash,
    signatureVerificationPolicyHash: reviewerSignatureVerificationPolicyHash,
    verifySignedReviewerReceipt: () => false,
    async execute() { throw new Error('execution_not_expected'); },
  });
  const providerConfiguration = resolveAutonomousResearchProviderConfiguration({
    options: {
      'agent-provider': 'codex',
      'codex-binary': '/usr/bin/true',
      'codex-home': root,
      model,
    },
  });
  const runtimePrincipalBinding = buildAutonomousResearchRuntimePrincipalBinding({
    authorPrincipalId: authorPreflight.effectivePrincipalId,
    authorIdentityConfigurationHash: selected.configuration.configurationHash,
    authorIdentitySubjectHash:
      selected.configuration.subject.externalPrincipalIdentityAttestationSubjectHash,
    authorCapabilityReceiptHash:
      authorPreflight.capabilityReceipt.codexResearchAuthorCapabilityReceiptHash,
    authorCredentialRootIdentityHash:
      authorPreflight.capabilityReceipt.credentialRootIdentityHash,
    researchPrincipalPoolHash,
    reviewerTrustSetHash,
    reviewerSignatureVerificationPolicyHash,
  });
  const productionAuthorityBinding =
    buildAutonomousResearchAgentProductionAuthorityBinding({
      runtimePrincipalBinding,
      autonomousResearchProviderConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      authorPrincipalId: authorPreflight.effectivePrincipalId,
      authorProvider: authorPreflight.capabilityReceipt.provider,
      authorModel: authorPreflight.capabilityReceipt.model,
      authorCapabilityReceiptHash:
        authorPreflight.capabilityReceipt.codexResearchAuthorCapabilityReceiptHash,
      authorCredentialRootIdentityHash:
        authorPreflight.capabilityReceipt.credentialRootIdentityHash,
      authorCredentialConfigIdentityHash:
        authorPreflight.capabilityReceipt.credentialConfigIdentityHash,
    });
  const workerInput = {
    options: { 'agent-provider': 'codex', model },
    plans: [{
      sourceWorkspace: root,
      requiresGpu: false,
      paperQualityRequirements: {
        formalVerificationRequired: true,
        empiricalVerificationRequired: false,
      },
      nodes: [{ kind: 'formal-verify' }],
      autonomousResearchPreparation: {
        launchMode: 'production-run',
        autonomousResearchProviderConfigurationHash:
          providerConfiguration.autonomousResearchProviderConfigurationHash,
        researchPrincipalPoolHash,
        runtimePrincipalBinding,
        runtimePrincipalBindingHash: runtimePrincipalBinding.runtimePrincipalBindingHash,
        productionAuthorityBinding,
        productionAuthorityBindingHash:
          productionAuthorityBinding
            .autonomousResearchAgentProductionAuthorityBindingHash,
      },
    }],
    runtimeRoot: path.join(root, 'runtime'),
    workspaceRegistry: {},
    campaignExecutionContext: {
      createFormalReviewAgentExecutor() {
        throw new Error('legacy_formal_reviewer_must_not_be_selected');
      },
    },
    services: { clock: { now: () => NOW } },
    environment: {
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG: configPath,
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH:
        selected.configuration.configurationHash,
      HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG: '/fixture/reviewer-pool.json',
    },
    providerConfiguration,
    expectedProviderConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    preflightResearchAuthor: () => authorPreflight,
    reviewerPrincipalPoolComposer(input) {
      reviewerPoolInput = input;
      return Object.freeze({
        configuration: Object.freeze({ configurationHash: H('worker-pool-config') }),
        executorPool,
        trustSetHash: reviewerTrustSetHash,
        signatureVerificationPolicyHash: reviewerSignatureVerificationPolicyHash,
      });
    },
  };
  const worker = composeCampaignWorkerExecution(workerInput);
  assert.equal(worker.reviewerPrincipalExecutorPool, executorPool);
  assert.equal(worker.nodeExecutor.verifySignedReviewerReceipt,
    executorPool.verifySignedReviewerReceipt);
  assert.equal(worker.researchPrincipalPool.researchPrincipalPoolHash,
    researchPrincipalPoolHash);
  assert.equal(reviewerPoolInput.authorIdentityAttestation.ready, true);
  assert.equal(reviewerPoolInput.authorIdentityAttestation.configurationPinned, true);
  assert.deepEqual(reviewerPoolInput.authorIdentityAttestation.subject,
    selected.configuration.subject);
  assert.equal(reviewerPoolInput.authorIdentityAttestation.verificationReceipt.subjectHash,
    selected.configuration.subject.externalPrincipalIdentityAttestationSubjectHash);
  assert.equal(reviewerPoolInput.clock.now(), NOW);

  const fieldRotations = [{ authorProvider: 'attacker-provider' }, {
    authorModel: 'attacker-model',
  }, { authorCredentialConfigIdentityHash: H('attacker-credential-config') }];
  for (const rotation of fieldRotations) {
    const storedBinding = buildAutonomousResearchAgentProductionAuthorityBinding({
      ...productionAuthorityBinding,
      ...rotation,
    });
    assert.throws(() => composeCampaignWorkerExecution({
      ...workerInput,
      plans: workerInput.plans.map((plan) => ({
        ...plan,
        autonomousResearchPreparation: {
          ...plan.autonomousResearchPreparation,
          productionAuthorityBinding: storedBinding,
          productionAuthorityBindingHash:
            storedBinding.autonomousResearchAgentProductionAuthorityBindingHash,
        },
      })),
    }), /autonomous_research_agent_production_authority_binding_invalid/);
  }
  assert.throws(() => composeCampaignWorkerExecution({
    ...workerInput,
    plans: workerInput.plans.map((plan) => ({
      ...plan,
      autonomousResearchPreparation: {
        ...plan.autonomousResearchPreparation,
        productionAuthorityBindingHash: H('mixed-production-binding-claim'),
      },
    })),
  }), /autonomous_research_agent_production_authority_binding_invalid/);

  const rotatedPair = crypto.generateKeyPairSync('ed25519');
  const rotatedConfiguration = buildAutonomousResearchAuthorIdentityConfiguration({
    subject: selected.configuration.subject,
    authorityEnvelope: signedEnvelope(rotatedPair, selected.configuration.subject),
    trustStore: Object.freeze({
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: [Object.freeze({
        keyId: 'author-identity-key',
        subjectId: 'rotated-author-identity-attestor',
        organization: 'Rotated Independent Identity Authority',
        algorithm: 'ed25519',
        publicKeyPem: rotatedPair.publicKey.export({ type: 'spki', format: 'pem' }),
        roles: [ROLE],
        status: 'active',
        effectiveFrom: '2026-07-19T00:00:00.000Z',
        expiresAt: '2026-07-20T00:00:00.000Z',
        revokedAt: null,
      })],
    }),
    signerKeyIds: ['author-identity-key'],
    maximumLifetimeMs: 5 * 60 * 1000,
  });
  const rotatedPath = writeConfiguration(root, 'author-rotated.json', rotatedConfiguration);
  assert.throws(() => composeCampaignWorkerExecution({
    ...workerInput,
    environment: {
      ...workerInput.environment,
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG: rotatedPath,
      HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH:
        rotatedConfiguration.configurationHash,
    },
  }), /autonomous_research_runtime_principal_binding_invalid/);

  const rotatedCredentialPayload = {
    ...capabilityPayload,
    credentialConfigIdentityHash: H('rotated-live-author-config'),
  };
  const rotatedCredentialAuthor = Object.freeze({
    ...authorPreflight,
    capabilityReceipt: Object.freeze({
      ...rotatedCredentialPayload,
      codexResearchAuthorCapabilityReceiptHash:
        hashRecord('CodexResearchAuthorCapabilityReceipt', rotatedCredentialPayload),
    }),
  });
  assert.throws(() => composeCampaignWorkerExecution({
    ...workerInput,
    preflightResearchAuthor: () => rotatedCredentialAuthor,
  }), /autonomous_research_runtime_principal_binding_invalid/);

  const rotatedProviderConfiguration = resolveAutonomousResearchProviderConfiguration({
    options: {
      'agent-provider': 'codex',
      'codex-binary': '/usr/bin/true',
      'codex-home': root,
      model: 'rotated-live-author-model',
    },
  });
  assert.throws(() => composeCampaignWorkerExecution({
    ...workerInput,
    providerConfiguration: rotatedProviderConfiguration,
    expectedProviderConfigurationHash:
      rotatedProviderConfiguration.autonomousResearchProviderConfigurationHash,
  }), /autonomous_research_provider_configuration_hash_mismatch/);
});
