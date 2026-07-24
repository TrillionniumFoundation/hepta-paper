import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPinnedExternalEvidenceEnvelope,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildSignedAutonomousVenueProfileRegistryConfiguration,
  readAutonomousVenueProfileRegistry,
} from '../../paper-adapters/automation/autonomous-venue-profile-registry-reader.mjs';
import {
  buildSignedAutonomousSubmissionMetadataProfileConfiguration,
  readAutonomousSubmissionMetadataProfile,
} from '../../paper-adapters/automation/autonomous-submission-metadata-profile-reader.mjs';
import {
  autonomousConfigurationAuthoritySigningPayload,
  buildAutonomousConfigurationAuthorityProof,
} from '../../paper-domain/automation/autonomous-configuration-authority-contract.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  buildAutonomousSubmissionMetadataProfile,
  buildAutonomousSubmissionMetadataReceipt,
  verifyAutonomousSubmissionMetadataReceipt,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  AUTONOMOUS_VENUE_SELECTOR_CONFIGURATION_HASH,
  buildAutonomousVenueProfile,
  buildAutonomousVenueProfileRegistry,
  selectAutonomousVenueProfile,
  verifyAutonomousVenueProfileSelection,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import { buildResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  buildVenueRequirementIr,
  verifyVenueRequirementIr,
} from '../../paper-domain/automation/venue-requirement-ir.mjs';
import {
  buildAutonomousVenueTemplateAssetBundle,
  buildAutonomousVenueTemplateAssetRecord,
} from '../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';
import {
  inspectAutonomousResearchProductionProfilePreparation,
} from '../../paper-domain/automation/autonomous-research-production-profile-contract.mjs';
import {
  genericManuscriptReleaseFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import {
  inspectPersistedAutonomousResearchVenueRequirementAuthority,
} from '../../paper-composition/automation/automation-readiness-venue-requirement-authority-inspection.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const OBSERVED_AT = new Date().toISOString();
const H = (label) => hashRecord('AutonomousVenueSignedRankingV2Test', { label });

function authority({ subjectKind, subjectHash, role, lifetimeMs = 60 * 60_000 }) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyId = `${role}-key`;
  const trustStore = Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [Object.freeze({
      keyId,
      subjectId: `${role}-subject`,
      organization: 'Signed Configuration Test Authority',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [role],
      status: 'active',
    })],
  });
  const observedAtMs = Date.parse(OBSERVED_AT);
  const unsigned = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt: new Date(observedAtMs - 60_000).toISOString(),
    expiresAt: new Date(observedAtMs + lifetimeMs).toISOString(),
    signatures: [{ keyId, role, algorithm: 'ed25519', value: 'placeholder' }],
  });
  const value = crypto.sign(
    null,
    autonomousConfigurationAuthoritySigningPayload(unsigned),
    pair.privateKey,
  ).toString('base64');
  const authorityEnvelope = buildPinnedExternalEvidenceEnvelope({
    ...unsigned,
    signatures: [{ keyId, role, algorithm: 'ed25519', value }],
  });
  const maximumLifetimeMs = lifetimeMs + 2 * 60_000;
  const proof = buildAutonomousConfigurationAuthorityProof({
    subjectKind,
    subjectHash,
    requiredRole: role,
    expectedKeyIds: [keyId],
    trustStore,
    authorityEnvelope,
    maximumLifetimeMs,
  }, { observedAt: OBSERVED_AT });
  return Object.freeze({ proof, trustStore, authorityEnvelope, keyId, maximumLifetimeMs });
}

function metadataProfile() {
  return buildAutonomousSubmissionMetadataProfile({
    profileId: 'signed-metadata-v2',
    authors: [{
      authorId: 'machine-author',
      displayName: 'Machine Author',
      affiliations: ['Machine Research Laboratory'],
      orcid: null,
      correspondingAuthor: true,
    }],
    defaultKeywords: ['causal inference', 'evidence binding'],
    conflictOfInterestStatement: 'No competing interests.',
    fundingStatement: 'No external funding.',
    dataAvailabilityStatement: 'Bound data are included in the evidence capsule.',
    codeAvailabilityStatement: 'Bound source is included in the release archive.',
    profileAuthorityReceiptHash: H('metadata-authority'),
  });
}

function venueProfile(venueId, scopeTerms) {
  return buildAutonomousVenueProfile({
    venueId,
    displayName: venueId.replaceAll('-', ' '),
    protocolFamilies: ['ml_algorithm_benchmark'],
    acceptedPaperTypes: ['research_article'],
    documentClass: 'article',
    bibliographyStyle: 'inline-evidence-v1',
    citationStyle: 'evidence-inline-v1',
    maximumPages: 16,
    requiredMetadata: [
      'title', 'abstract', 'authors', 'keywords', 'conflict_of_interest',
      'funding', 'data_availability', 'code_availability',
    ],
    submissionPortalProfileId: `${venueId}-portal`,
    externalSubmissionEnabled: true,
    profileAuthorityReceiptHash: H(`${venueId}:authority`),
    scopeTerms,
    minimumScopeMatchCount: 1,
  });
}

function fixture() {
  const profile = metadataProfile();
  const registry = buildAutonomousVenueProfileRegistry({
    registryId: 'signed-ranked-venues-v2',
    profiles: [
      venueProfile('venue-ai-substring-trap', ['ai']),
      venueProfile('venue-broad-fit', ['causal inference', 'unmatched specialty']),
      venueProfile('venue-exact-fit', ['causal inference', 'ml algorithm benchmark']),
    ],
  });
  const venueAuthority = authority({
    subjectKind: 'AutonomousVenueProfileRegistry',
    subjectHash: registry.autonomousVenueProfileRegistryHash,
    role: 'venue_profile_authority',
  });
  const metadataAuthority = authority({
    subjectKind: 'AutonomousSubmissionMetadataProfile',
    subjectHash: profile.profileHash,
    role: 'submission_metadata_authority',
  });
  return { profile, registry, venueAuthority, metadataAuthority };
}

function venueRequirementSpecification(templateAssetHash = H('venue-v3-template')) {
  return Object.freeze({
    anonymousReview: true,
    reviewMode: 'double-anonymous',
    wordLimit: 8_000,
    sectionLimits: Object.freeze([
      Object.freeze({ section: 'abstract', maximumWords: 250 }),
      Object.freeze({ section: 'limitations', maximumWords: 1_000 }),
      Object.freeze({ section: 'methods', maximumWords: 3_000 }),
      Object.freeze({ section: 'results', maximumWords: 3_000 }),
    ]),
    templateAssetHash,
    supplementPolicy: 'Supplement is permitted and must be independently archived.',
    artifactRequired: true,
    artifactPolicy: 'A replayable artifact is required.',
    disclosureRequirements: Object.freeze([
      'funding statement', 'conflict-of-interest statement',
    ]),
  });
}

test('signed venue profile v3 is the sole source of a generic Venue Requirement IR', (t) => {
  const paperId = 'signed-venue-requirement-paper';
  const campaignId = `autonomous-research:${paperId}`;
  const objective = 'Causal inference using the registered ML benchmark.';
  const templateBytes = Buffer.from(
    '\\ProvidesFile{venue-generic-v3.tex}[signed fixture]\n',
    'utf8',
  );
  const templateAssetHash = hashBytes(templateBytes);
  const metadata = metadataProfile();
  const profile = buildAutonomousVenueProfile({
    venueId: 'venue-generic-v3',
    displayName: 'Venue Generic V3',
    protocolFamilies: ['ml_algorithm_benchmark'],
    acceptedPaperTypes: ['research_article'],
    documentClass: 'article',
    bibliographyStyle: 'inline-evidence-v1',
    citationStyle: 'evidence-inline-v1',
    maximumPages: 16,
    requiredMetadata: [
      'title', 'abstract', 'authors', 'keywords', 'conflict_of_interest',
      'funding', 'data_availability', 'code_availability',
    ],
    submissionPortalProfileId: 'venue-generic-v3-portal',
    externalSubmissionEnabled: true,
    profileAuthorityReceiptHash: H('venue-generic-v3:authority'),
    scopeTerms: ['causal inference', 'ml algorithm benchmark'],
    minimumScopeMatchCount: 1,
    requirementSpecification: venueRequirementSpecification(templateAssetHash),
  });
  const registry = buildAutonomousVenueProfileRegistry({
    registryId: 'signed-ranked-venues-v3',
    profiles: [profile],
  });
  const templateAsset = buildAutonomousVenueTemplateAssetRecord({
    venueId: profile.venueId,
    relativePath: 'venue-assets/venue-generic-v3.tex',
    bytesBase64: templateBytes.toString('base64'),
    sizeBytes: templateBytes.length,
    templateAssetHash,
  });
  const templateAssetBundle = buildAutonomousVenueTemplateAssetBundle({
    registry,
    assets: [templateAsset],
  });
  const venueAuthority = authority({
    subjectKind: 'AutonomousVenueTemplateAssetBundle',
    subjectHash: templateAssetBundle.autonomousVenueTemplateAssetBundleHash,
    role: 'venue_profile_authority',
  });
  const metadataAuthority = authority({
    subjectKind: 'AutonomousSubmissionMetadataProfile',
    subjectHash: metadata.profileHash,
    role: 'submission_metadata_authority',
  });
  const selection = selectAutonomousVenueProfile({
    registry,
    paperId,
    protocolFamily: 'ml_algorithm_benchmark',
    objective,
    submissionMetadataProfile: metadata,
    registryAuthorityProof: venueAuthority.proof,
    submissionMetadataAuthorityProof: metadataAuthority.proof,
    venueTemplateAssetBundle: templateAssetBundle,
    requireExternalSubmission: true,
    selectedAt: OBSERVED_AT,
    authorityObservedAt: OBSERVED_AT,
  });
  const productionFixture = genericManuscriptReleaseFixture({
    paperId,
    campaignId,
    objective,
    protocolFamily: 'ml_algorithm_benchmark',
  });
  const agendaReceipt = productionFixture.preparation.researchAgendaProducerReceipt;
  const agenda = buildResearchAgendaIr({
    agendaProductionReceipt: agendaReceipt,
    researchQuestion: 'Does the registered treatment improve the primary metric?',
    primaryClaim: 'The treatment improves the primary metric relative to baseline.',
    dataRequirements: {
      population: 'Rows admitted by the signed dataset contract.',
      intervention: 'Registered treatment implementation.',
      comparator: 'Registered baseline implementation.',
      estimand: 'Paired mean primary-metric difference.',
      requiredVariables: ['outcome', 'treatment_assignment'],
      datasetConstraints: ['read-only signed dataset mount'],
    },
    falsifiers: ['Non-positive paired primary-metric difference.'],
    negativeBoundaries: ['No claim outside the signed dataset population.'],
    formalTargets: ['Prove the metric aggregation invariant.'],
    priorArtQueryPlan: ['Search the intervention and estimand concepts together.'],
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
  });
  const ir = buildVenueRequirementIr({
    researchAgendaIr: agenda,
    venueProfileSelection: selection,
  });
  assert.equal(profile.version, 3);
  assert.equal(registry.version, 3);
  assert.equal(ir.venueRequirementAuthorityReceiptHash, venueAuthority.proof.configurationHash);
  assert.deepEqual(ir.sectionLimits, venueRequirementSpecification().sectionLimits);
  assert.equal(verifyVenueRequirementIr(ir, {
    researchAgendaIr: agenda,
    venueProfile: profile,
    venueProfileSelection: selection,
  }), true);
  assert.equal(verifyVenueRequirementIr({ ...ir, wordLimit: 9_000 }, {
    researchAgendaIr: agenda,
  }), false);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-venue-v3-config-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const configuration = buildSignedAutonomousVenueProfileRegistryConfiguration({
    registry,
    trustStore: venueAuthority.trustStore,
    authorityEnvelope: venueAuthority.authorityEnvelope,
    expectedKeyIds: [venueAuthority.keyId],
    maximumLifetimeMs: venueAuthority.maximumLifetimeMs,
    observedAt: OBSERVED_AT,
    templateAssets: [templateAsset],
  });
  const configPath = path.join(base, 'venue-v3.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  const read = readAutonomousVenueProfileRegistry({
    configPath,
    expectedConfigurationHash: configuration.configurationHash,
    now: new Date(OBSERVED_AT),
  });
  assert.equal(read.registry.version, 3);
  assert.equal(
    read.registry.profiles[0].requirementSpecification.templateAssetHash,
    templateAssetHash,
  );

  const capabilityScopeManifest = buildAutonomousResearchCapabilityScopeManifest({
    scopeId: 'hepta.test.venue-requirement-v3',
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1'],
    empiricalFamilies: ['ml_algorithm_benchmark'],
    priorArtMode: 'structured-ranked-deduplicated-v2',
    reviewerPrincipalCount: 2,
    reviewerTrustDomainCount: 2,
    replayMode: 'external-trust-domain-v1',
    venueMode: 'submission-enabled-v1',
  });
  const submissionMetadataReceipt = buildAutonomousSubmissionMetadataReceipt({
    paperId,
    protocolFamily: 'ml_algorithm_benchmark',
    profile: metadata,
    profileAuthorityProof: metadataAuthority.proof,
    selectedAt: OBSERVED_AT,
    authorityObservedAt: OBSERVED_AT,
  });
  const preparationPayload = {
    ...productionFixture.preparation,
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
    launchMode: 'production-run',
    proposal: Object.freeze({
      ...productionFixture.preparation.proposal,
      paperId,
      objective,
      protocolFamily: 'ml_algorithm_benchmark',
    }),
    researchAgendaProducerReceipt: agendaReceipt,
    researchAgendaIr: agenda,
    venueProfileSelection: selection,
    venueRequirementIr: ir,
    submissionMetadataReceipt,
    capabilityScopeManifest,
    createdAt: OBSERVED_AT,
    observedAt: OBSERVED_AT,
  };
  const preparation = Object.freeze({
    ...preparationPayload,
    autonomousResearchLoopPreparationReportHash: hashRecord(
      'AutonomousResearchLoopPreparationReport', preparationPayload,
    ),
  });
  const planPayload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId,
    autonomousResearchPreparation: preparation,
  };
  const plan = Object.freeze({
    ...planPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', planPayload),
  });
  const store = Object.freeze({
    query: () => Object.freeze({
      ok: true,
      rows: Object.freeze([Object.freeze({
        campaign_id: plan.campaignId,
        paper_id: paperId,
        spec_json: JSON.stringify(plan),
        updated_at: OBSERVED_AT,
      })]),
    }),
  });
  const persisted = inspectPersistedAutonomousResearchVenueRequirementAuthority({
    store,
    expectedVenueProfileRegistryHash: registry.autonomousVenueProfileRegistryHash,
    expectedVenueAuthorityConfigurationHash: configuration.configurationHash,
    expectedSubmissionMetadataAuthorityConfigurationHash:
      metadataAuthority.proof.configurationHash,
    expectedAgendaAuthorityInspection: Object.freeze({
      ready: true,
      campaignId,
      paperId,
      campaignPlanHash: plan.campaignPlanHash,
      researchAgendaIr: agenda,
    }),
  });
  assert.equal(persisted.ready, true);
  assert.equal(persisted.venueRequirementIr.venueRequirementIrHash,
    ir.venueRequirementIrHash);
  assert.equal(inspectPersistedAutonomousResearchVenueRequirementAuthority({
    store,
    expectedVenueProfileRegistryHash: H('different-registry'),
    expectedVenueAuthorityConfigurationHash: configuration.configurationHash,
    expectedSubmissionMetadataAuthorityConfigurationHash:
      metadataAuthority.proof.configurationHash,
    expectedAgendaAuthorityInspection: Object.freeze({
      ready: true,
      campaignId,
      paperId,
      campaignPlanHash: plan.campaignPlanHash,
      researchAgendaIr: agenda,
    }),
  }).ready, false);
});

test('strong venue v2 ranks every candidate from local signed scope and metadata evidence', () => {
  const selected = fixture();
  const selection = selectAutonomousVenueProfile({
    registry: selected.registry,
    paperId: 'signed-ranking-paper',
    protocolFamily: 'ml_algorithm_benchmark',
    objective: 'Training systems for causal inference with reproducible evidence.',
    submissionMetadataProfile: selected.profile,
    registryAuthorityProof: selected.venueAuthority.proof,
    submissionMetadataAuthorityProof: selected.metadataAuthority.proof,
    requireExternalSubmission: true,
    selectedAt: OBSERVED_AT,
    authorityObservedAt: OBSERVED_AT,
  });
  const ranking = selection.rankingReceipt;
  assert.equal(selection.version, 2);
  assert.equal(selection.venueId, 'venue-exact-fit');
  assert.equal(ranking.algorithmId, 'scope-fit-constraints-v1');
  assert.equal(ranking.selectorConfigurationHash, AUTONOMOUS_VENUE_SELECTOR_CONFIGURATION_HASH);
  assert.equal(ranking.evaluatedCandidateCount, 3);
  assert.deepEqual(
    ranking.candidateEvaluations.filter((candidate) => candidate.rank).map((candidate) => (
      candidate.rank
    )).sort((left, right) => left - right),
    [1, 2],
  );
  const substringTrap = ranking.candidateEvaluations.find((candidate) => (
    candidate.venueId === 'venue-ai-substring-trap'
  ));
  assert.deepEqual(substringTrap.matchedScopeTerms, []);
  assert.ok(substringTrap.blockers.includes('minimum-scope-fit-not-met'));
  assert.equal(substringTrap.rank, null);
  assert.ok(ranking.candidateEvaluations.every((candidate) => (
    Number.isSafeInteger(candidate.totalScoreMicros)
  )));
  assert.equal(ranking.venueAuthorityTrustSetHash, selected.venueAuthority.proof.trustSetHash);
  assert.equal(
    ranking.submissionMetadataAuthorityConfigurationHash,
    selected.metadataAuthority.proof.configurationHash,
  );
  assert.equal(verifyAutonomousVenueProfileSelection(selection, {
    authorityObservedAt: OBSERVED_AT,
  }), true);
  assert.equal(verifyAutonomousVenueProfileSelection(selection), false);

  const metadataReceipt = buildAutonomousSubmissionMetadataReceipt({
    paperId: selection.paperId,
    protocolFamily: selection.protocolFamily,
    profile: selected.profile,
    profileAuthorityProof: selected.metadataAuthority.proof,
    selectedAt: OBSERVED_AT,
    authorityObservedAt: OBSERVED_AT,
  });
  assert.equal(metadataReceipt.version, 2);
  assert.equal(verifyAutonomousSubmissionMetadataReceipt(metadataReceipt, {
    authorityObservedAt: OBSERVED_AT,
  }), true);
  assert.equal(verifyAutonomousSubmissionMetadataReceipt(metadataReceipt), false);

  const tampered = structuredClone(selection);
  tampered.rankingReceipt.candidateEvaluations[0].totalScoreMicros += 1;
  const { autonomousVenueProfileRankingReceiptHash: _rankingHash, ...rankingPayload } =
    tampered.rankingReceipt;
  tampered.rankingReceipt.autonomousVenueProfileRankingReceiptHash = hashRecord(
    'AutonomousVenueProfileRankingReceipt', rankingPayload,
  );
  const { autonomousVenueProfileSelectionReceiptHash: _selectionHash, ...selectionPayload } =
    tampered;
  tampered.autonomousVenueProfileSelectionReceiptHash = hashRecord(
    'AutonomousVenueProfileSelectionReceipt', selectionPayload,
  );
  assert.equal(verifyAutonomousVenueProfileSelection(tampered, {
    authorityObservedAt: OBSERVED_AT,
  }), false);
  assert.equal(verifyAutonomousVenueProfileSelection(selection, {
    authorityObservedAt: new Date(Date.parse(OBSERVED_AT) + 2 * 60 * 60_000).toISOString(),
  }), false);
});

test('signed venue and metadata readers require the externally pinned configuration hash', (t) => {
  const selected = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-signed-venue-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const venueConfiguration = buildSignedAutonomousVenueProfileRegistryConfiguration({
    registry: selected.registry,
    trustStore: selected.venueAuthority.trustStore,
    authorityEnvelope: selected.venueAuthority.authorityEnvelope,
    expectedKeyIds: [selected.venueAuthority.keyId],
    maximumLifetimeMs: selected.venueAuthority.maximumLifetimeMs,
    observedAt: OBSERVED_AT,
  });
  const metadataConfiguration = buildSignedAutonomousSubmissionMetadataProfileConfiguration({
    profile: selected.profile,
    trustStore: selected.metadataAuthority.trustStore,
    authorityEnvelope: selected.metadataAuthority.authorityEnvelope,
    expectedKeyIds: [selected.metadataAuthority.keyId],
    maximumLifetimeMs: selected.metadataAuthority.maximumLifetimeMs,
    observedAt: OBSERVED_AT,
  });
  const venuePath = path.join(root, 'venues.json');
  const metadataPath = path.join(root, 'metadata.json');
  fs.writeFileSync(venuePath, JSON.stringify(venueConfiguration), { mode: 0o600 });
  fs.writeFileSync(metadataPath, JSON.stringify(metadataConfiguration), { mode: 0o600 });
  const venue = readAutonomousVenueProfileRegistry({
    configPath: venuePath,
    expectedConfigurationHash: venueConfiguration.configurationHash,
    now: new Date(OBSERVED_AT),
  });
  const metadata = readAutonomousSubmissionMetadataProfile({
    configPath: metadataPath,
    expectedConfigurationHash: metadataConfiguration.configurationHash,
    now: new Date(OBSERVED_AT),
  });
  assert.equal(venue.configurationPinned, true);
  assert.equal(metadata.configurationPinned, true);
  assert.deepEqual(venue.registry, selected.registry);
  assert.deepEqual(metadata.profile, selected.profile);
  assert.throws(() => readAutonomousVenueProfileRegistry({
    configPath: venuePath,
    expectedConfigurationHash: H('wrong-venue-pin'),
    now: new Date(OBSERVED_AT),
  }), /configuration_pin_invalid/);
  assert.throws(() => readAutonomousSubmissionMetadataProfile({
    configPath: metadataPath,
    expectedConfigurationHash: H('wrong-metadata-pin'),
    now: new Date(OBSERVED_AT),
  }), /configuration_pin_invalid/);
});

test('legacy v1 hash selection remains bounded-compatible but is not a strong ranking receipt', () => {
  const registry = buildAutonomousVenueProfileRegistry({
    registryId: 'bounded-venues-v1',
    profiles: [buildAutonomousVenueProfile({
      venueId: 'bounded-venue',
      displayName: 'Bounded Venue',
      protocolFamilies: ['ml_algorithm_benchmark'],
      profileAuthorityReceiptHash: H('bounded-authority'),
    })],
  });
  const selection = selectAutonomousVenueProfile({
    registry,
    paperId: 'bounded-paper',
    protocolFamily: 'ml_algorithm_benchmark',
  });
  assert.equal(selection.version, 1);
  assert.equal(selection.rankingReceipt, undefined);
  assert.equal(verifyAutonomousVenueProfileSelection(selection), true);
});

test('a legacy or unsigned venue cannot make an otherwise strong production preparation green', () => {
  const strong = genericManuscriptReleaseFixture({
    paperId: 'strong-venue-downgrade-paper',
    campaignId: 'strong-venue-downgrade-campaign',
  });
  const profile = metadataProfile();
  const legacyRegistry = buildAutonomousVenueProfileRegistry({
    registryId: 'legacy-production-downgrade',
    profiles: [buildAutonomousVenueProfile({
      venueId: 'legacy-production-venue',
      displayName: 'Legacy Production Venue',
      protocolFamilies: ['ml_algorithm_benchmark'],
      bibliographyStyle: 'inline-evidence-v1',
      citationStyle: 'evidence-inline-v1',
      submissionPortalProfileId: 'legacy-portal',
      externalSubmissionEnabled: true,
      profileAuthorityReceiptHash: H('legacy-production-authority'),
    })],
  });
  const legacySelection = selectAutonomousVenueProfile({
    registry: legacyRegistry,
    paperId: strong.preparation.proposal.paperId,
    protocolFamily: strong.preparation.proposal.protocolFamily,
    selectedAt: OBSERVED_AT,
  });
  const legacyMetadata = buildAutonomousSubmissionMetadataReceipt({
    paperId: strong.preparation.proposal.paperId,
    protocolFamily: strong.preparation.proposal.protocolFamily,
    profile,
    selectedAt: OBSERVED_AT,
  });
  const inspection = inspectAutonomousResearchProductionProfilePreparation({
    ...strong.preparation,
    venueProfileSelection: legacySelection,
    submissionMetadataReceipt: legacyMetadata,
  });
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes(
    'autonomous_research_production_signed_venue_ranking_required',
  ));
});
