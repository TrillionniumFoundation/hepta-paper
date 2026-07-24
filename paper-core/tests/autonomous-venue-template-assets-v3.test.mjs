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
  prepareAutonomousResearchLoop,
} from '../../paper-application/automation/autonomous-research-readiness.mjs';
import {
  composeAutonomousResearchExternalCapabilities,
} from '../../paper-composition/automation/autonomous-research-external-capability-composition.mjs';
import {
  autonomousConfigurationAuthoritySigningPayload,
  buildAutonomousConfigurationAuthorityProof,
} from '../../paper-domain/automation/autonomous-configuration-authority-contract.mjs';
import {
  buildAutonomousSubmissionMetadataProfile,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  buildAutonomousVenueProfile,
  buildAutonomousVenueProfileRegistry,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  buildAutonomousVenueTemplateAssetBundle,
  buildAutonomousVenueTemplateAssetRecord,
} from '../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const OBSERVED_AT = '2026-07-23T00:00:00.000Z';
const H = (label) => hashRecord('AutonomousVenueTemplateAssetsV3Test', { label });

function authority({ subjectKind, subjectHash, role }) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const keyId = `${role}-asset-fixture-key`;
  const trustStore = Object.freeze({
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [Object.freeze({
      keyId,
      subjectId: `${role}-asset-fixture-subject`,
      organization: 'Venue Asset Test Authority',
      algorithm: 'ed25519',
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [role],
      status: 'active',
    })],
  });
  const unsigned = buildPinnedExternalEvidenceEnvelope({
    subjectKind,
    subjectHash,
    signedAt: '2026-07-22T23:59:00.000Z',
    expiresAt: '2026-07-23T01:00:00.000Z',
    signatures: [{ keyId, role, algorithm: 'ed25519', value: 'placeholder' }],
  });
  const signature = crypto.sign(
    null,
    autonomousConfigurationAuthoritySigningPayload(unsigned),
    pair.privateKey,
  ).toString('base64');
  const authorityEnvelope = buildPinnedExternalEvidenceEnvelope({
    ...unsigned,
    signatures: [{ keyId, role, algorithm: 'ed25519', value: signature }],
  });
  const maximumLifetimeMs = 2 * 60 * 60_000;
  const proof = buildAutonomousConfigurationAuthorityProof({
    subjectKind,
    subjectHash,
    requiredRole: role,
    expectedKeyIds: [keyId],
    trustStore,
    authorityEnvelope,
    maximumLifetimeMs,
  }, { observedAt: OBSERVED_AT });
  return Object.freeze({
    proof, trustStore, authorityEnvelope, keyId, maximumLifetimeMs,
  });
}

function metadataProfile() {
  return buildAutonomousSubmissionMetadataProfile({
    profileId: 'venue-asset-test-metadata',
    authors: [{
      authorId: 'asset-test-author',
      displayName: 'Asset Test Author',
      affiliations: ['Venue Asset Laboratory'],
      orcid: null,
      correspondingAuthor: true,
    }],
    defaultKeywords: ['machine learning', 'venue template'],
    conflictOfInterestStatement: 'No competing interests.',
    fundingStatement: 'No external funding.',
    dataAvailabilityStatement: 'Bound evidence is available.',
    codeAvailabilityStatement: 'Bound code is available.',
    profileAuthorityReceiptHash: H('metadata-authority'),
  });
}

function venueProfile({ venueId, templateAssetHash, version = 3 }) {
  return buildAutonomousVenueProfile({
    venueId,
    displayName: venueId,
    protocolFamilies: ['ml_algorithm_benchmark'],
    documentClass: 'article',
    bibliographyStyle: 'inline-evidence-v1',
    citationStyle: 'evidence-inline-v1',
    requiredMetadata: ['title', 'abstract', 'authors', 'keywords'],
    submissionPortalProfileId: `${venueId}-portal`,
    externalSubmissionEnabled: true,
    profileAuthorityReceiptHash: H(`${venueId}:authority`),
    scopeTerms: ['machine learning benchmark'],
    minimumScopeMatchCount: 1,
    ...(version === 3 ? {
      requirementSpecification: {
        anonymousReview: true,
        reviewMode: 'double_anonymous',
        wordLimit: 8_000,
        sectionLimits: [
          { section: 'methods', maximumWords: 3_000 },
          { section: 'results', maximumWords: 3_000 },
        ],
        templateAssetHash,
        supplementPolicy: 'A signed supplement is accepted.',
        artifactRequired: true,
        artifactPolicy: 'A replayable artifact is required.',
        disclosureRequirements: ['Automated authorship must be disclosed.'],
      },
    } : {}),
  });
}

function asset({ venueId, source, relativePath = `venue-assets/${venueId}.tex` }) {
  const bytes = Buffer.from(source, 'utf8');
  return buildAutonomousVenueTemplateAssetRecord({
    venueId,
    relativePath,
    bytesBase64: bytes.toString('base64'),
    sizeBytes: bytes.length,
    templateAssetHash: hashBytes(bytes),
  });
}

function v3Fixture() {
  const templateAsset = asset({
    venueId: 'venue-asset-v3',
    source: '\\ProvidesFile{venue-asset-v3.tex}[signed]\n\\newcommand{\\venueName}{Asset V3}\n',
  });
  const profile = venueProfile({
    venueId: templateAsset.venueId,
    templateAssetHash: templateAsset.templateAssetHash,
  });
  const registry = buildAutonomousVenueProfileRegistry({
    registryId: 'venue-assets-v3',
    profiles: [profile],
  });
  const bundle = buildAutonomousVenueTemplateAssetBundle({
    registry,
    assets: [templateAsset],
  });
  const venueAuthority = authority({
    subjectKind: 'AutonomousVenueTemplateAssetBundle',
    subjectHash: bundle.autonomousVenueTemplateAssetBundleHash,
    role: 'venue_profile_authority',
  });
  return Object.freeze({ templateAsset, profile, registry, bundle, venueAuthority });
}

test('signed v3 registry supplies immutable template bytes through loop preparation', async (t) => {
  const fixture = v3Fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-venue-assets-v3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = buildSignedAutonomousVenueProfileRegistryConfiguration({
    registry: fixture.registry,
    templateAssets: [fixture.templateAsset],
    trustStore: fixture.venueAuthority.trustStore,
    authorityEnvelope: fixture.venueAuthority.authorityEnvelope,
    expectedKeyIds: [fixture.venueAuthority.keyId],
    maximumLifetimeMs: fixture.venueAuthority.maximumLifetimeMs,
    observedAt: OBSERVED_AT,
  });
  assert.equal(configuration.version, 3);
  assert.equal(configuration.authorityEnvelope.subjectKind,
    'AutonomousVenueTemplateAssetBundle');
  assert.equal(configuration.authorityEnvelope.subjectHash,
    configuration.templateAssetBundle.autonomousVenueTemplateAssetBundleHash);
  const configPath = path.join(root, 'venues.json');
  fs.writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
  const verified = readAutonomousVenueProfileRegistry({
    configPath,
    expectedConfigurationHash: configuration.configurationHash,
    now: new Date(OBSERVED_AT),
  });
  assert.equal(Object.isFrozen(verified.templateAssetBundle), true);
  assert.equal(Object.isFrozen(verified.templateAssets), true);
  assert.equal(Object.isFrozen(verified.templateAssets[0]), true);
  assert.deepEqual(verified.templateAssets, [fixture.templateAsset]);

  const metadata = metadataProfile();
  const metadataAuthority = authority({
    subjectKind: 'AutonomousSubmissionMetadataProfile',
    subjectHash: metadata.profileHash,
    role: 'submission_metadata_authority',
  });
  const preparation = await prepareAutonomousResearchLoop({
    paperId: 'venue-template-loop-preparation',
    objective: 'Evaluate a machine learning benchmark under signed venue constraints.',
    protocolFamily: 'ml_algorithm_benchmark',
    venueProfileRegistry: verified.registry,
    venueProfileRegistryAuthority: verified,
    venueTemplateAssetBundle: verified.templateAssetBundle,
    submissionMetadataProfile: metadata,
    submissionMetadataAuthority: Object.freeze({ authorityProof: metadataAuthority.proof }),
    createdAt: OBSERVED_AT,
  });
  assert.deepEqual(preparation.venueTemplateAsset, fixture.templateAsset);
  assert.equal(preparation.venueTemplateAssetBundleHash,
    fixture.bundle.autonomousVenueTemplateAssetBundleHash);
  assert.equal(preparation.venueTemplateAssetAuthorityConfigurationHash,
    configuration.configurationHash);
  assert.equal(preparation.venueProfileSelection.venueTemplateAssetBundleHash,
    preparation.venueTemplateAssetBundleHash);
});

test('template records reject hash, path, base64, mode, and unsafe preamble attacks', () => {
  const bytes = Buffer.from('\\ProvidesFile{safe.tex}[signed]\n', 'utf8');
  const valid = {
    venueId: 'venue-adversarial',
    relativePath: 'venue-assets/venue-adversarial.tex',
    bytesBase64: bytes.toString('base64'),
    sizeBytes: bytes.length,
    templateAssetHash: hashBytes(bytes),
  };
  for (const candidate of [
    { ...valid, templateAssetHash: H('wrong-bytes') },
    { ...valid, sizeBytes: bytes.length + 1 },
    { ...valid, relativePath: '../venue-adversarial.tex' },
    { ...valid, relativePath: '/venue-assets/venue-adversarial.tex' },
    { ...valid, relativePath: 'venue-assets\\venue-adversarial.tex' },
    { ...valid, relativePath: 'venue-assets/venue-adversarial.sty' },
    { ...valid, bytesBase64: 'YR==' },
    { ...valid, bytesBase64: '!!!!' },
    { ...valid, applicationMode: 'copy-only-v1' },
  ]) assert.throws(
    () => buildAutonomousVenueTemplateAssetRecord(candidate),
    /autonomous_venue_template_asset_invalid/,
  );
  for (const source of [
    '\\documentclass{article}',
    '\\begin{document}attack\\end{document}',
    '\\input{../../secret}',
    '\\write18{attack}',
  ]) {
    const unsafe = Buffer.from(source, 'utf8');
    assert.throws(() => buildAutonomousVenueTemplateAssetRecord({
      ...valid,
      bytesBase64: unsafe.toString('base64'),
      sizeBytes: unsafe.length,
      templateAssetHash: hashBytes(unsafe),
    }), /autonomous_venue_template_asset_invalid/);
  }
});

test('v3 bundle rejects missing, extra, and cross-venue asset splices', () => {
  const left = asset({ venueId: 'venue-left', source: '\\ProvidesFile{left.tex}[signed]\n' });
  const right = asset({ venueId: 'venue-right', source: '\\ProvidesFile{right.tex}[signed]\n' });
  const registry = buildAutonomousVenueProfileRegistry({
    registryId: 'venue-splice-registry',
    profiles: [
      venueProfile({ venueId: left.venueId, templateAssetHash: left.templateAssetHash }),
      venueProfile({ venueId: right.venueId, templateAssetHash: right.templateAssetHash }),
    ],
  });
  assert.throws(() => buildAutonomousVenueTemplateAssetBundle({
    registry, assets: [left],
  }), /bundle_invalid/);
  assert.throws(() => buildAutonomousVenueTemplateAssetBundle({
    registry, assets: [left, right, asset({
      venueId: 'venue-extra', source: '\\ProvidesFile{extra.tex}[signed]\n',
    })],
  }), /bundle_invalid/);
  const splicedLeft = buildAutonomousVenueTemplateAssetRecord({
    ...right,
    venueId: left.venueId,
    relativePath: 'venue-assets/venue-left.tex',
  });
  const splicedRight = buildAutonomousVenueTemplateAssetRecord({
    ...left,
    venueId: right.venueId,
    relativePath: 'venue-assets/venue-right.tex',
  });
  assert.throws(() => buildAutonomousVenueTemplateAssetBundle({
    registry,
    assets: [splicedLeft, splicedRight],
  }), /profile_binding_invalid/);
});

test('reader rejects post-signature asset tampering and registry-only v3 authority', (t) => {
  const fixture = v3Fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-venue-assets-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = buildSignedAutonomousVenueProfileRegistryConfiguration({
    registry: fixture.registry,
    templateAssets: [fixture.templateAsset],
    trustStore: fixture.venueAuthority.trustStore,
    authorityEnvelope: fixture.venueAuthority.authorityEnvelope,
    expectedKeyIds: [fixture.venueAuthority.keyId],
    maximumLifetimeMs: fixture.venueAuthority.maximumLifetimeMs,
    observedAt: OBSERVED_AT,
  });
  const tampered = structuredClone(configuration);
  tampered.templateAssetBundle.assets[0].relativePath =
    'venue-assets/different-safe-name.tex';
  const configPath = path.join(root, 'tampered.json');
  fs.writeFileSync(configPath, JSON.stringify(tampered), { mode: 0o600 });
  assert.throws(() => readAutonomousVenueProfileRegistry({
    configPath,
    expectedConfigurationHash: configuration.configurationHash,
    now: new Date(OBSERVED_AT),
  }), /verification_failed/);

  const registryOnlyAuthority = authority({
    subjectKind: 'AutonomousVenueProfileRegistry',
    subjectHash: fixture.registry.autonomousVenueProfileRegistryHash,
    role: 'venue_profile_authority',
  });
  assert.throws(() => buildSignedAutonomousVenueProfileRegistryConfiguration({
    registry: fixture.registry,
    templateAssets: [fixture.templateAsset],
    trustStore: registryOnlyAuthority.trustStore,
    authorityEnvelope: registryOnlyAuthority.authorityEnvelope,
    expectedKeyIds: [registryOnlyAuthority.keyId],
    maximumLifetimeMs: registryOnlyAuthority.maximumLifetimeMs,
    observedAt: OBSERVED_AT,
  }), /subject_binding_invalid/);
});

test('v2 signed registries remain compatible while v3 external capability fails closed', (t) => {
  const v2 = venueProfile({
    venueId: 'venue-compatible-v2',
    templateAssetHash: H('unused-v2-template'),
    version: 2,
  });
  const v2Registry = buildAutonomousVenueProfileRegistry({
    registryId: 'venue-compatible-v2-registry',
    profiles: [v2],
  });
  const v2Authority = authority({
    subjectKind: 'AutonomousVenueProfileRegistry',
    subjectHash: v2Registry.autonomousVenueProfileRegistryHash,
    role: 'venue_profile_authority',
  });
  const v2Configuration = buildSignedAutonomousVenueProfileRegistryConfiguration({
    registry: v2Registry,
    trustStore: v2Authority.trustStore,
    authorityEnvelope: v2Authority.authorityEnvelope,
    expectedKeyIds: [v2Authority.keyId],
    maximumLifetimeMs: v2Authority.maximumLifetimeMs,
    observedAt: OBSERVED_AT,
  });
  assert.equal(v2Configuration.version, 2);
  assert.equal(v2Configuration.templateAssetBundle, undefined);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-venue-assets-v2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'venues.json');
  fs.writeFileSync(configPath, JSON.stringify(v2Configuration), { mode: 0o600 });
  const verifiedV2 = readAutonomousVenueProfileRegistry({
    configPath,
    expectedConfigurationHash: v2Configuration.configurationHash,
    now: new Date(OBSERVED_AT),
  });
  assert.equal(verifiedV2.version, 2);
  assert.equal(verifiedV2.templateAssets, undefined);

  const fixture = v3Fixture();
  const missing = composeAutonomousResearchExternalCapabilities({
    paperId: 'venue-assets-missing-capability',
    refereeCount: 1,
    requestedContentMode: 'deterministic-bounded',
    dynamicFormalClaimsEnabled: false,
    venueProfileRegistry: fixture.registry,
    requestedProtocolFamily: 'ml_algorithm_benchmark',
    environment: {},
  });
  assert.ok(missing.blockers.includes('autonomous_research_venue_template_assets_required'));
  assert.ok(missing.contentCapabilityScopeManifest.externalPrerequisites
    .includes('venue-template-assets'));
  const supplied = composeAutonomousResearchExternalCapabilities({
    paperId: 'venue-assets-supplied-capability',
    refereeCount: 1,
    requestedContentMode: 'deterministic-bounded',
    dynamicFormalClaimsEnabled: false,
    venueProfileRegistry: fixture.registry,
    venueTemplateAssetBundle: fixture.bundle,
    requestedProtocolFamily: 'ml_algorithm_benchmark',
    environment: {},
  });
  assert.equal(supplied.blockers.includes(
    'autonomous_research_venue_template_assets_required',
  ), false);
  assert.equal(supplied.effectiveVenueTemplateAssetBundle,
    fixture.bundle);
});
