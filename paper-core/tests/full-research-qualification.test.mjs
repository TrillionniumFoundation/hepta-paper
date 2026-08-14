import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyFullResearchQualificationReceipt as verifyProductionFullResearchQualificationReceipt,
  verifyFullResearchQualificationReceiptEnvelope as verifyProductionFullResearchQualificationReceiptEnvelope,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
  materializeAutonomousResearchRecurringGoldenIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  MANUSCRIPT_RELEASE_PROOF_FIELDS,
} from '../../paper-domain/automation/full-research-release-qualification-inspection.mjs';
import {
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import {
  genericManuscriptReleaseFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import {
  importFullResearchQualificationForTest,
} from './support/production-experiment-closure-test-seam.mjs';
import {
  REQUIRED_SCOPED_SCHEMA_VERSIONS,
} from '../../paper-domain/automation/scoped-schema-version-contract.mjs';
import {
  inspectResearchReportForClosure,
} from '../../paper-domain/automation/research-closure-receipt-contract.mjs';

const {
  fullResearchQualificationSigningPayloadHash,
  providerPrincipalIndependenceAttestationSigningPayloadHash,
  verifyFullResearchQualificationReceipt,
  verifyFullResearchQualificationReceiptEnvelope,
} = await importFullResearchQualificationForTest();

const ISSUED_AT = '2026-07-15T08:00:00.000Z';
const NOW = new Date('2026-07-15T09:00:00.000Z');
const HASH = (label) => hashRecord('FullResearchQualificationTestHash', { label });
let qualificationManuscriptFixture = null;

function hashed(kind, hashField, payload) {
  return Object.freeze({ ...payload, [hashField]: hashRecord(kind, payload) });
}

function capability(kind) {
  const author = kind === 'author';
  const recordKind = author ? 'CodexResearchAuthorCapabilityReceipt' : 'CodexFormalReviewerCapabilityReceipt';
  const hashField = author
    ? 'codexResearchAuthorCapabilityReceiptHash'
    : 'codexFormalReviewerCapabilityReceiptHash';
  const payload = {
    version: 1,
    kind: recordKind,
    status: author ? 'codex_research_author_capability_ready' : 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model: author ? 'author-model' : 'reviewer-model',
    codexVersion: 'codex-cli 1.0.0',
    codexBinaryIdentityHash: HASH('codex-binary'),
    credentialRootIdentityHash: HASH('author-root'),
    credentialConfigIdentityHash: HASH('author-config'),
    authenticationStatus: 'codex_authentication_verified',
    modelOptionVerified: true,
    selectedModelExecutionCanaryVerified: false,
    ...(author ? {
      workspaceWriteRequired: true,
      dynamicAttemptWorkspaceRequired: true,
      freshEphemeralSessionRequired: true,
      priorAgentContextInheritanceForbidden: true,
      assuranceScope: 'filesystem_credential_root_runtime_and_model_selection_preflight',
      providerAccountIdentityAttested: false,
      externalActionPerformed: false,
    } : {
      authorProvider: 'codex',
      authorCredentialRootIdentityHash: HASH('author-root'),
      credentialIndependenceVerified: false,
      providerCredentialSharingPermitted: true,
      freshEphemeralSessionRequired: true,
      authorContextInheritanceForbidden: true,
      frozenArtifactReviewRequired: true,
      reviewerMustDifferFromAuthorPrincipal: true,
      assuranceScope: 'ephemeral_session_frozen_artifact_and_role_separation',
      providerAccountIndependenceVerified: false,
      readOnlyReviewRequired: true,
      dynamicAttemptWorkspaceRequired: true,
    }),
  };
  return hashed(recordKind, hashField, payload);
}

function canary(capabilityRecord, label, observedAt) {
  const observedAtMs = Date.parse(observedAt);
  const payload = {
    version: 1,
    kind: 'CodexModelAvailabilityCanaryReceipt',
    status: 'codex_model_live_canary_verified',
    provider: capabilityRecord.provider,
    model: capabilityRecord.model,
    codexVersion: capabilityRecord.codexVersion,
    codexBinaryIdentityHash: capabilityRecord.codexBinaryIdentityHash,
    credentialRootIdentityHash: capabilityRecord.credentialRootIdentityHash,
    credentialConfigIdentityHash: capabilityRecord.credentialConfigIdentityHash,
    authenticationStatus: capabilityRecord.authenticationStatus,
    selectedModelExecutionCanaryVerified: true,
    challengeHash: HASH(`${label}-challenge`),
    responseHash: HASH(`${label}-response`),
    observedAt,
    expiresAt: new Date(observedAtMs + 15 * 60 * 1000).toISOString(),
    externalActionPerformed: true,
    externalActionScope: 'single_read_only_ephemeral_model_canary',
  };
  return hashed('CodexModelAvailabilityCanaryReceipt', 'codexModelAvailabilityCanaryReceiptHash', payload);
}

function schemaReceipt() {
  const requiredVersions = [...REQUIRED_SCOPED_SCHEMA_VERSIONS];
  const payload = {
    version: 1,
    kind: 'ScopedSchemaVersionGateReceipt',
    status: 'scoped_schema_version_verified',
    rootKind: 'automation-status',
    requiredVersions,
    observedVersions: requiredVersions,
    migrationHashes: Object.fromEntries(requiredVersions.map(
      (version) => [version, HASH(`migration-${version}`)],
    )),
    blockers: [],
  };
  return hashed('ScopedSchemaVersionGateReceipt', 'scopedSchemaVersionGateReceiptHash', payload);
}

function releaseAuthority(signer) {
  const releaseBundleHash = HASH('release-bundle');
  const campaignPlanHash = HASH('campaign-plan');
  qualificationManuscriptFixture ||= genericManuscriptReleaseFixture({
    paperId: 'paper-golden',
    campaignId: 'campaign-golden',
    campaignPlanHash,
    proposalHash: HASH('proposal'),
    policyAuthorizationHash: HASH('policy'),
    seedBindingHash: HASH('seed'),
    externalSubmission: true,
  });
  const manuscriptFixture = qualificationManuscriptFixture;
  const report = manuscriptFixture.researchReport;
  const binding = report.capabilities.proposalClaimToTheoremBinding;
  const manifest = {
    status: 'research_evidence_capsule_ready',
    academicExperimentCount: 1,
    experimentCount: 1,
    experiments: [{
      experimentId: 'experiment-1',
      academicPromotionEligible: true,
      independentRecomputationImplementationVerified: true,
      recomputationIndependenceLevel: 'repository-separate-implementation-same-process-v1',
      rawEventRecomputationIndependenceContractHash: HASH('recomputation-independence-contract'),
      recomputationProcessIndependent: false,
    }],
  };
  return { authority: {
    status: 'current_completed_release',
    campaignStatus: 'completed',
    packageNodeStatus: 'completed',
    campaignId: 'campaign-golden',
    paperId: 'paper-golden',
    campaignReleaseBundleHash: releaseBundleHash,
    promotedAt: '2026-07-15T07:55:00.000Z',
    releaseBundle: {
      status: 'campaign_release_bundle_prepared',
      campaignReleaseBundleHash: releaseBundleHash,
      campaignPlanHash,
      autonomousResearchReleaseBinding: manuscriptFixture.releaseBinding,
      autonomousResearchReleaseBindingHash:
        manuscriptFixture.releaseBinding.autonomousResearchReleaseBindingHash,
      campaignResearchSourceSnapshotHash:
        report.campaignResearchSourceSnapshotHash,
      researchReportHash: report.researchReportHash,
      proposalClaimToTheoremBindingHash: binding.proposalClaimToTheoremBindingHash,
      experimentRegistryHash: report.experimentRegistryHash,
      researchReport: report,
      researchEvidenceCapsuleManifest: manifest,
      researchExecutionReleaseAttestation: {
        ...signer,
        signedAt: '2026-07-15T07:50:00.000Z',
        validFrom: '2026-07-15T07:50:00.000Z',
        expiresAt: '2026-07-16T07:50:00.000Z',
      },
      packageOutput: { researchEvidenceCapsuleManifestFileHash: HASH('manifest-file') },
      createdAt: '2026-07-15T07:50:00.000Z',
    },
  }, manuscriptFixture };
}

function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const signer = {
    keyId: 'release-key', keyVersion: 'legacy-v1',
    subjectId: 'release-attestor', organization: 'release-office',
    role: 'research_execution_release_attestor', algorithm: 'ed25519',
  };
  const author = capability('author');
  const reviewer = capability('reviewer');
  const schema = schemaReceipt();
  const codeProvenance = {
    version: 2, packageVersion: '0.21.0', commit: 'a'.repeat(40), commitTree: 'b'.repeat(40),
    treeDirty: true, indexStateHash: HASH('index'), repositoryEntryCount: 999,
    repositoryContentHash: HASH('repo'), worktreeStateHash: HASH('worktree'),
  };
  const runtimeImageDigests = Object.fromEntries(
    REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES
      .map((profile) => [profile, HASH(`${profile}-image`)]),
  );
  const runtimeImageReproducibilityReceiptHash = HASH('runtime-reproducibility-receipt');
  const runtimeImageReproducibilityRequiredProfiles =
    REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES;
  const runtimeImageReproducibilityDefinitionManifestHashes = Object.fromEntries(
    REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES
      .map((profile) => [profile, HASH(`${profile}-definition`)]),
  );
  const receiptAuthorCanary = canary(author, 'receipt-author', '2026-07-15T07:55:00.000Z');
  const receiptReviewerCanary = canary(reviewer, 'receipt-reviewer', '2026-07-15T07:55:00.000Z');
  const currentAuthorCanary = canary(author, 'current-author', '2026-07-15T08:55:00.000Z');
  const currentReviewerCanary = canary(reviewer, 'current-reviewer', '2026-07-15T08:55:00.000Z');
  const release = releaseAuthority(signer);
  const authority = release.authority;
  const releaseBinding = authority.releaseBundle.autonomousResearchReleaseBinding;
  const principalAttestationUnsigned = {
    version: 1,
    kind: 'ProviderPrincipalIndependenceAttestation',
    status: 'provider_principal_independence_attested',
    assurance: 'external-operator-attested-distinct-provider-accounts-v1',
    authorCredentialConfigIdentityHash: author.credentialConfigIdentityHash,
    reviewerCredentialConfigIdentityHash: reviewer.credentialConfigIdentityHash,
    authorProviderAccountIdentityHash: HASH('author-account'),
    reviewerProviderAccountIdentityHash: HASH('reviewer-account'),
    signer,
    attestedAt: ISSUED_AT,
    expiresAt: '2026-07-16T08:00:00.000Z',
  };
  const principalAttestationSigned = {
    ...principalAttestationUnsigned,
    signature: crypto.sign(
      null,
      Buffer.from(hashRecord('ProviderPrincipalIndependenceAttestationSigningPayload', principalAttestationUnsigned), 'utf8'),
      pair.privateKey,
    ).toString('base64'),
  };
  const providerPrincipalIndependenceAttestation = {
    ...principalAttestationSigned,
    providerPrincipalIndependenceAttestationHash:
      hashRecord('ProviderPrincipalIndependenceAttestation', principalAttestationSigned),
  };
  const unsigned = {
    version: 1,
    kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
    status: 'full_research_golden_micro_campaign_qualified',
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    proposalHash: releaseBinding.proposalHash,
    policyAuthorizationHash: releaseBinding.policyAuthorizationHash,
    seedBindingHash: releaseBinding.seedBindingHash,
    qualificationScope: releaseBinding.qualificationScope,
    genericContentCanaryVerified: releaseBinding.genericContentCanaryVerified,
    ...Object.fromEntries(MANUSCRIPT_RELEASE_PROOF_FIELDS.map((field) => (
      [field, releaseBinding[field]]
    ))),
    codeProvenance,
    researchAuthorCapabilityReceipt: author,
    formalReviewerCapabilityReceipt: reviewer,
    campaignStoreSchemaReceipt: schema,
    runtimeImageDigests,
    runtimeImageReproducibilityReceiptHash,
    runtimeImageReproducibilityRequiredProfiles,
    runtimeImageReproducibilityDefinitionManifestHashes,
    empiricalFamilyPluginPackageHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginStartupInspectionHash,
    activeEmpiricalProductionProfileHashes:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.activeProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .runtimeImageReproducibilityActivePluginScopeHash,
    researchAuthorProviderCanaryReceipt: receiptAuthorCanary,
    formalReviewerProviderCanaryReceipt: receiptReviewerCanary,
    providerPrincipalIndependenceAttestation,
    independentHypothesisPriorArtReviewVerified: true,
    independentHypothesisPriorArtReceiptHash:
      releaseBinding.priorArtEvidenceReceiptHash,
    priorArtEvidenceReceipt: releaseBinding.priorArtEvidenceReceipt,
    signer,
    issuedAt: ISSUED_AT,
    expiresAt: '2026-07-16T08:00:00.000Z',
    externalActionPerformed: true,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(hashRecord('FullResearchQualificationSigningPayload', unsigned), 'utf8'),
    pair.privateKey,
  ).toString('base64');
  const signed = { ...unsigned, signature };
  const receipt = {
    ...signed,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', signed),
  };
  const context = {
    now: NOW,
    codeProvenance,
    researchAuthorCapabilityReceipt: author,
    formalReviewerCapabilityReceipt: reviewer,
    campaignStoreSchemaReceipt: schema,
    runtimeImageDigests,
    runtimeImageReproducibilityInspection: {
      version: 2,
      kind: 'RuntimeImageReproducibilityReceiptInspection',
      status: 'runtime_image_reproducibility_verified',
      ready: true,
      receiptAccepted: true,
      receiptHash: runtimeImageReproducibilityReceiptHash,
      requiredProfiles: runtimeImageReproducibilityRequiredProfiles,
      definitionManifestHashes: runtimeImageReproducibilityDefinitionManifestHashes,
      empiricalFamilyPluginPackageHash:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginPackageHash,
      empiricalFamilyPluginRegistryHash:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginRegistryHash,
      empiricalFamilyPluginStartupInspectionHash:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
          .empiricalFamilyPluginStartupInspectionHash,
      activeProductionProfileHashes:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.activeProductionProfileHashes,
      runtimeImageReproducibilityActivePluginScopeHash:
        RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
          .runtimeImageReproducibilityActivePluginScopeHash,
      blockers: [],
    },
    researchAuthorProviderCanaryReceipt: currentAuthorCanary,
    formalReviewerProviderCanaryReceipt: currentReviewerCanary,
    releaseAttestorInspection: {
      ready: true,
      ...signer,
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      expiresAt: '2027-07-01T00:00:00.000Z',
    },
    resolveCampaignReleaseAuthority: () => authority,
    verifyReleaseAttestation: () => true,
    verifyQualificationSignature: ({ signingPayloadHash, signature: value, signer: observed }) => (
      observed.keyId === signer.keyId
      && crypto.verify(null, Buffer.from(signingPayloadHash, 'utf8'), pair.publicKey, Buffer.from(value, 'base64'))
    ),
    runtimePrincipalBinding: release.manuscriptFixture.preparation.runtimePrincipalBinding,
    reviewerEvidenceAuthority: release.manuscriptFixture.reviewerEvidenceAuthority,
  };
  return { pair, signer, receipt, context, authority };
}

function resign(f, mutate) {
  const { signature: _signature, fullResearchQualificationReceiptHash: _hash, ...unsigned } = f.receipt;
  const changed = mutate(structuredClone(unsigned));
  const signature = crypto.sign(
    null,
    Buffer.from(hashRecord('FullResearchQualificationSigningPayload', changed), 'utf8'),
    f.pair.privateKey,
  ).toString('base64');
  const signed = { ...changed, signature };
  return { ...signed, fullResearchQualificationReceiptHash: hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', signed) };
}

function globallyBoundAuthority(f, { launchMode }) {
  const providerConfigurationHash = HASH(`provider:${launchMode}`);
  const sourceAuthorityHash = HASH(`configuration:${launchMode}`);
  const datasetMounts = [{
    name: `qualification-${launchMode}`,
    source: `/datasets/qualification-${launchMode}`,
    readOnly: true,
    manifestHash: HASH(`dataset:${launchMode}`),
    licenseId: 'CC0-1.0',
    benchmarkFamily: 'ml_algorithm_benchmark',
  }];
  let intake;
  if (launchMode === 'golden-bootstrap') {
    const template = buildAutonomousResearchRecurringGoldenTemplate({
      templateId: 'persistent-global-qualification',
      epochDurationMs: 12 * 60 * 60 * 1000,
      objective: 'Continuously verify the persisted global qualification authority.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts,
      providerConfigurationHash,
      revisionRounds: 1,
      refereeCount: 2,
    });
    intake = materializeAutonomousResearchRecurringGoldenIntake({
      template,
      now: new Date(ISSUED_AT),
      sourceAuthorityHash,
    });
  } else {
    intake = buildAutonomousResearchMachineIntake({
      intakeId: 'intake:paper-golden',
      paperId: 'paper-golden',
      campaignId: 'autonomous-research:paper-golden',
      launchMode: 'production-run',
      objective: 'Verify that production qualification remains campaign local.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts,
      budgets: {
        maxWallTimeMs: 60 * 60 * 1000,
        maxAgentCalls: 8,
        maxCpuJobs: 8,
        maxGpuJobs: 0,
        maxTokenCount: 10_000,
        maxCostUsd: 10,
        maxMemoryMiB: 2048,
      },
      providerConfigurationHash,
      revisionRounds: 1,
      refereeCount: 2,
      admissionCreatedAt: ISSUED_AT,
    });
  }
  const campaignId = intake.campaignId;
  const paperId = intake.paperId;
  const admission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind: launchMode === 'golden-bootstrap' ? 'recurring-golden' : 'machine',
    sourceAuthorityHash,
  });
  const campaignPlanHash = HASH(`plan:${launchMode}`);
  const manuscriptFixture = genericManuscriptReleaseFixture({
    campaignId,
    paperId,
    launchMode,
    campaignPlanHash,
    objective: intake.objective,
    protocolFamily: intake.protocolFamily,
    proposalHash: HASH(`proposal:${launchMode}`),
    policyAuthorizationHash: HASH(`policy:${launchMode}`),
    seedBindingHash: HASH(`seed:${launchMode}`),
    externalSubmission: true,
    includeResearchReport: true,
    machineIntake: intake,
    machineIntakeAdmission: admission,
  });
  const report = manuscriptFixture.researchReport;
  const releaseBinding = manuscriptFixture.releaseBinding;
  const authority = structuredClone(f.authority);
  authority.campaignId = campaignId;
  authority.paperId = paperId;
  authority.releaseBundle.campaignPlanHash = campaignPlanHash;
  authority.releaseBundle.autonomousResearchReleaseBinding = releaseBinding;
  authority.releaseBundle.autonomousResearchReleaseBindingHash =
    releaseBinding.autonomousResearchReleaseBindingHash;
  authority.releaseBundle.campaignResearchSourceSnapshotHash =
    report.campaignResearchSourceSnapshotHash;
  authority.releaseBundle.researchReportHash = report.researchReportHash;
  authority.releaseBundle.proposalClaimToTheoremBindingHash =
    report.proposalClaimToTheoremBindingHash;
  authority.releaseBundle.experimentRegistryHash = report.experimentRegistryHash;
  authority.releaseBundle.researchReport = report;
  return {
    authority,
    receipt: resign(f, (value) => ({
      ...value,
      campaignId,
      paperId,
      proposalHash: releaseBinding.proposalHash,
      policyAuthorizationHash: releaseBinding.policyAuthorizationHash,
      seedBindingHash: releaseBinding.seedBindingHash,
      qualificationScope: releaseBinding.qualificationScope,
      genericContentCanaryVerified: releaseBinding.genericContentCanaryVerified,
      independentHypothesisPriorArtReceiptHash:
        releaseBinding.priorArtEvidenceReceiptHash,
      priorArtEvidenceReceipt: releaseBinding.priorArtEvidenceReceipt,
      ...Object.fromEntries(MANUSCRIPT_RELEASE_PROOF_FIELDS.map((field) => (
        [field, releaseBinding[field]]
      ))),
    })),
  };
}

test('a fresh attestor-signed qualification bound to current code, providers, schema, images and full release verifies', () => {
  const f = fixture();
  assert.match(providerPrincipalIndependenceAttestationSigningPayloadHash(
    f.receipt.providerPrincipalIndependenceAttestation,
  ), /^sha256:/);
  assert.equal(fullResearchQualificationSigningPayloadHash(f.receipt),
    hashRecord('FullResearchQualificationSigningPayload', (() => {
      const { signature: _signature, fullResearchQualificationReceiptHash: _hash, ...payload } = f.receipt;
      return payload;
    })()));
  const result = verifyFullResearchQualificationReceipt(f.receipt, f.context);
  assert.equal(result.ready, true, JSON.stringify(result.blockers));
  assert.equal(result.receiptAccepted, true);
  const productionResult = verifyProductionFullResearchQualificationReceipt(
    f.receipt,
    f.context,
  );
  assert.equal(productionResult.ready, false);
  assert.equal(productionResult.receiptAccepted, false);
  assert.equal(result.campaignReleaseBundleHash, f.authority.campaignReleaseBundleHash);
  assert.equal(result.independentHypothesisPriorArtReviewVerified, true);
  assert.equal(
    result.independentHypothesisPriorArtReceiptHash,
    f.receipt.independentHypothesisPriorArtReceiptHash,
  );
});

test('full research qualification fails closed on missing, tampered, and spliced GPU lineage', () => {
  const attacks = [
    {
      label: 'missing promotion evidence',
      blocker: 'golden_micro_campaign_gpu_scientific_promotion_evidence_invalid',
      alter(bundle) {
        bundle.gpuScientificCampaignPromotionEvidenceHash =
          HASH('declared-but-missing-gpu-promotion');
      },
    },
    {
      label: 'research GPU evidence hash remnant',
      blocker: 'golden_micro_campaign_gpu_scientific_promotion_evidence_invalid',
      alter(bundle) {
        bundle.campaignResearchGpuScientificEvidenceHash =
          HASH('partial-gpu-research-evidence-remnant');
      },
    },
    {
      label: 'research authority inspection hash remnant',
      blocker: 'golden_micro_campaign_gpu_scientific_promotion_evidence_invalid',
      alter(bundle) {
        bundle.gpuScientificCampaignQualificationAuthorityInspectionHash =
          HASH('partial-gpu-authority-inspection-remnant');
      },
    },
    {
      label: 'tampered capsule descriptor',
      blocker: 'golden_micro_campaign_gpu_scientific_capsule_binding_invalid',
      alter(bundle) {
        bundle.researchEvidenceCapsuleManifest.gpuScientificEvidenceIncluded = true;
        bundle.researchEvidenceCapsuleManifest.gpuScientificEvidence = {
          gpuScientificEvidenceDescriptorHash: HASH('tampered-gpu-descriptor'),
        };
      },
    },
    {
      label: 'foreign promotion candidate splice',
      blocker: 'golden_micro_campaign_gpu_scientific_research_projection_mismatch',
      alter(bundle) {
        bundle.gpuScientificExecutionPlanHash = HASH('gpu-plan');
        bundle.gpuScientificExecutionPlan = {
          gpuScientificCampaignExecutionPlanHash:
            bundle.gpuScientificExecutionPlanHash,
        };
        bundle.promotionCandidate = {
          campaignId: 'foreign-campaign',
          paperId: bundle.researchReport.paperId,
          campaignPlanHash: bundle.campaignPlanHash,
          gpuScientificExecutionPlanHash: bundle.gpuScientificExecutionPlanHash,
          gpuScientificExecutionPlan: bundle.gpuScientificExecutionPlan,
        };
      },
    },
    {
      label: 'tampered package GPU file binding',
      blocker: 'golden_micro_campaign_gpu_scientific_package_output_binding_invalid',
      alter(bundle) {
        bundle.gpuScientificCampaignPromotionEvidenceHash = HASH('gpu-promotion');
        bundle.packageOutput.files = [{
          role: 'research_evidence_capsule_file',
          capsuleRole: 'gpu_scientific_campaign_qualification_evidence',
          packageRelativePath: 'evidence/gpu-scientific/FOREIGN.json',
          hash: HASH('foreign-gpu-package-file'),
          bytes: 1,
        }];
      },
    },
    {
      label: 'foreign release attestation splice',
      blocker: 'golden_micro_campaign_gpu_scientific_release_attestation_binding_invalid',
      alter(bundle) {
        bundle.gpuScientificCampaignPromotionEvidenceHash = HASH('gpu-promotion');
        bundle.researchExecutionReleaseAttestationHash =
          HASH('expected-gpu-release-attestation');
        bundle.researchExecutionReleaseAttestation
          .campaignReleaseExecutionAttestationHash =
            HASH('foreign-gpu-release-attestation');
      },
    },
  ];
  for (const { label, blocker, alter } of attacks) {
    const f = fixture();
    const authority = structuredClone(f.authority);
    alter(authority.releaseBundle);
    const result = verifyFullResearchQualificationReceipt(f.receipt, {
      ...f.context,
      resolveCampaignReleaseAuthority: () => authority,
    });
    assert.equal(result.ready, false, label);
    assert.ok(result.blockers.includes(blocker),
      `${label}: ${JSON.stringify(result.blockers)}`);
  }
});

test('persisted global readiness rejects an authentic production-run qualification substitution', () => {
  const goldenFixture = fixture();
  const golden = globallyBoundAuthority(goldenFixture, { launchMode: 'golden-bootstrap' });
  const verified = verifyFullResearchQualificationReceipt(golden.receipt, {
    ...goldenFixture.context,
    requireGlobalGoldenAuthority: true,
    resolveCampaignReleaseAuthority: () => golden.authority,
  });
  assert.equal(verified.ready, true, JSON.stringify(verified.blockers));

  const strictBounded = verifyFullResearchQualificationReceipt(golden.receipt, {
    ...goldenFixture.context,
    requireGlobalGoldenAuthority: false,
    resolveCampaignReleaseAuthority: () => golden.authority,
  });
  assert.equal(strictBounded.ready, false);
  assert.ok(strictBounded.blockers.includes(
    'golden_micro_campaign_release_qualification_scope_invalid',
  ));
  const strictBoundedEnvelope = verifyFullResearchQualificationReceiptEnvelope(
    golden.receipt,
    {
      now: NOW,
      campaignReleaseAuthority: golden.authority,
      expectedPaperId: golden.receipt.paperId,
      expectedProposalHash: golden.receipt.proposalHash,
      expectedPolicyAuthorizationHash: golden.receipt.policyAuthorizationHash,
      expectedSeedBindingHash: golden.receipt.seedBindingHash,
      verifyQualificationSignature:
        goldenFixture.context.verifyQualificationSignature,
      allowBoundedGoldenCapability: false,
    },
  );
  assert.equal(strictBoundedEnvelope.ready, false);
  assert.ok(strictBoundedEnvelope.blockers.includes(
    'external_qualification_release_scope_not_eligible',
  ));
  assert.ok(strictBoundedEnvelope.blockers.includes(
    'external_qualification_independent_hypothesis_prior_art_qualification_invalid',
  ));

  const boundedReleaseBundle = golden.authority.releaseBundle;
  const boundedClosureInspection = inspectResearchReportForClosure(
    boundedReleaseBundle.researchReport,
    boundedReleaseBundle,
    boundedReleaseBundle.autonomousResearchReleaseBinding,
  );
  assert.equal(boundedClosureInspection.valid, false);
  assert.ok(boundedClosureInspection.blockers.includes(
    'research_closure_report_report_hash_binding_invalid',
  ));
  assert.ok(boundedClosureInspection.blockers.includes(
    'research_closure_report_formal_report_matches_release_proposal_invalid',
  ));

  const tamperedPriorArtAuthority = structuredClone(golden.authority);
  const tamperedPriorArtBinding =
    tamperedPriorArtAuthority.releaseBundle.autonomousResearchReleaseBinding;
  tamperedPriorArtBinding.priorArtEvidenceReceipt.priorArtQueryPlan[0] =
    'tampered bounded prior-art query';
  const {
    autonomousResearchReleaseBindingHash: _priorBindingHash,
    ...tamperedPriorArtBindingPayload
  } = tamperedPriorArtBinding;
  tamperedPriorArtBinding.autonomousResearchReleaseBindingHash =
    hashRecord('AutonomousResearchReleaseBinding', tamperedPriorArtBindingPayload);
  tamperedPriorArtAuthority.releaseBundle.autonomousResearchReleaseBindingHash =
    tamperedPriorArtBinding.autonomousResearchReleaseBindingHash;
  const tamperedPriorArtReceipt = resign({
    ...goldenFixture,
    receipt: golden.receipt,
  }, (value) => ({
    ...value,
    priorArtEvidenceReceipt:
      structuredClone(tamperedPriorArtBinding.priorArtEvidenceReceipt),
  }));
  const tamperedPriorArt = verifyFullResearchQualificationReceipt(
    tamperedPriorArtReceipt,
    {
      ...goldenFixture.context,
      requireGlobalGoldenAuthority: true,
      resolveCampaignReleaseAuthority: () => tamperedPriorArtAuthority,
    },
  );
  assert.ok(tamperedPriorArt.blockers.includes(
    'golden_micro_campaign_independent_hypothesis_prior_art_qualification_invalid',
  ));
  assert.equal(tamperedPriorArt.blockers.includes(
    'golden_micro_campaign_release_qualification_scope_invalid',
  ), false, JSON.stringify(tamperedPriorArt.blockers));

  for (const mutate of [
    (authority) => {
      authority.releaseBundle.campaignResearchSourceSnapshotHash =
        HASH('bounded-source-splice');
    },
    (authority) => {
      authority.releaseBundle.researchReport.capabilities
        .formalCertificateIntakes[0].authoritativeFormalNodeResultHash =
          HASH('bounded-intake-tamper');
    },
    (authority) => {
      authority.releaseBundle.researchReport.capabilities
        .proposalClaimToTheoremBinding.claimAuthorityBindingHash =
          HASH('bounded-proposal-authority-splice');
    },
  ]) {
    const attackedAuthority = structuredClone(golden.authority);
    mutate(attackedAuthority);
    const attacked = verifyFullResearchQualificationReceipt(golden.receipt, {
      ...goldenFixture.context,
      requireGlobalGoldenAuthority: true,
      resolveCampaignReleaseAuthority: () => attackedAuthority,
    });
    assert.ok(attacked.blockers.includes(
      'golden_micro_campaign_formal_release_required',
    ), JSON.stringify(attacked.blockers));
  }

  const productionFixture = fixture();
  const production = globallyBoundAuthority(productionFixture, { launchMode: 'production-run' });
  const formalDonorSpliceAuthority = structuredClone(golden.authority);
  formalDonorSpliceAuthority.releaseBundle.researchReport.capabilities
    .formalCertificateIntakes = structuredClone(
      production.authority.releaseBundle.researchReport.capabilities
        .formalCertificateIntakes,
    );
  const formalDonorSplice = verifyFullResearchQualificationReceipt(
    golden.receipt,
    {
      ...goldenFixture.context,
      requireGlobalGoldenAuthority: true,
      resolveCampaignReleaseAuthority: () => formalDonorSpliceAuthority,
    },
  );
  assert.ok(formalDonorSplice.blockers.includes(
    'golden_micro_campaign_formal_release_required',
  ), JSON.stringify(formalDonorSplice.blockers));

  const substituted = verifyFullResearchQualificationReceipt(production.receipt, {
    ...productionFixture.context,
    requireGlobalGoldenAuthority: true,
    resolveCampaignReleaseAuthority: () => production.authority,
  });
  assert.equal(substituted.ready, false);
  assert.ok(substituted.blockers.includes(
    'golden_micro_campaign_global_golden_qualification_authority_required',
  ));
});

test('qualification attacks fail closed at every required binding', () => {
  const attacks = [
    ['code_worktree_identity_mismatch', (r) => { r.codeProvenance.worktreeStateHash = HASH('wrong-worktree'); return r; }],
    ['research_author_configuration_mismatch', (r) => { r.researchAuthorCapabilityReceipt.model = 'substitute-model'; return r; }],
    ['formal_reviewer_configuration_mismatch', (r) => { r.formalReviewerCapabilityReceipt.freshEphemeralSessionRequired = false; return r; }],
    ['store_schema_mismatch', (r) => { r.campaignStoreSchemaReceipt.observedVersions = [21, 22]; return r; }],
    ['runtime_image_digests_mismatch', (r) => { r.runtimeImageDigests.python = HASH('tag-repoint'); return r; }],
    ['runtime_image_reproducibility_binding_invalid', (r) => {
      r.runtimeImageReproducibilityReceiptHash = HASH('stale-reproducibility'); return r;
    }],
    ['research_author_provider_canary_invalid', (r) => { r.researchAuthorProviderCanaryReceipt.responseHash = HASH('fake-response'); return r; }],
    ['independent_hypothesis_prior_art_qualification_invalid', (r) => { r.independentHypothesisPriorArtReviewVerified = false; return r; }],
    ['independent_hypothesis_prior_art_qualification_invalid', (r) => { delete r.independentHypothesisPriorArtReceiptHash; return r; }],
    ['independent_hypothesis_prior_art_qualification_invalid', (r) => { r.independentHypothesisPriorArtReceiptHash = 'not-a-hash'; return r; }],
    ['release_attestor_identity_mismatch', (r) => { r.signer.keyId = 'attacker-key'; return r; }],
    ['release_attestor_identity_mismatch', (r) => { r.signer.keyVersion = 'attacker-version'; return r; }],
    ['release_pointer_mismatch', (r) => { r.campaignReleaseBundleHash = HASH('unrelated-release'); return r; }],
  ];
  for (const [blocker, mutation] of attacks) {
    const f = fixture();
    const result = verifyFullResearchQualificationReceipt(resign(f, mutation), f.context);
    assert.equal(result.ready, false, blocker);
    assert.ok(result.blockers.some((item) => item.includes(blocker)), JSON.stringify(result.blockers));
  }
});

test('legacy qualification receipts without a reproducibility receipt binding fail closed', () => {
  const f = fixture();
  const legacy = resign(f, (receipt) => {
    delete receipt.runtimeImageReproducibilityReceiptHash;
    delete receipt.runtimeImageReproducibilityRequiredProfiles;
    delete receipt.runtimeImageReproducibilityDefinitionManifestHashes;
    return receipt;
  });
  const result = verifyFullResearchQualificationReceipt(legacy, f.context);
  assert.ok(result.blockers.includes(
    'golden_micro_campaign_runtime_image_reproducibility_binding_invalid',
  ));
});

test('expired, stale, non-formal, non-academic and untrusted releases cannot qualify', () => {
  {
    const f = fixture();
    const result = verifyFullResearchQualificationReceipt(f.receipt, { ...f.context, now: new Date('2026-07-16T08:00:00.000Z') });
    assert.ok(result.blockers.includes('golden_micro_campaign_qualification_receipt_outside_time_window'));
  }
  for (const [blocker, alter] of [
    ['golden_micro_campaign_release_not_fresh', (a) => { a.releaseBundle.createdAt = '2026-07-13T00:00:00.000Z'; }],
    ['golden_micro_campaign_release_attestation_outside_time_window', (a) => { a.releaseBundle.researchExecutionReleaseAttestation.expiresAt = '2026-07-15T08:30:00.000Z'; }],
    ['golden_micro_campaign_formal_release_required', (a) => { a.releaseBundle.researchReport.capabilities.formalReplayReceipts = []; }],
    ['golden_micro_campaign_formal_release_required', (a) => {
      a.releaseBundle.researchReport.capabilities.formalCertificateIntakes[0].version = 2;
    }],
    ['golden_micro_campaign_formal_release_required', (a) => {
      a.releaseBundle.researchReport.capabilities
        .formalCertificateIntakes[0].claimBindingsHash =
          HASH('tampered-embedded-formal-execution');
    }],
    ['golden_micro_campaign_formal_release_required', (a) => {
      a.releaseBundle.researchReport.nativeResearchWorkerExecution.workerReceipts[0]
        .result.replayReceipt.projectManifestHash =
          HASH('spliced-native-formal-replay');
    }],
    ['golden_micro_campaign_formal_release_required', (a) => {
      a.releaseBundle.campaignResearchSourceSnapshotHash =
        HASH('unrelated-research-source');
    }],
    ['golden_micro_campaign_academic_empirical_release_required', (a) => { a.releaseBundle.researchEvidenceCapsuleManifest.academicExperimentCount = 0; }],
    ['golden_micro_campaign_recomputation_implementation_independence_required', (a) => {
      a.releaseBundle.researchEvidenceCapsuleManifest.experiments[0]
        .independentRecomputationImplementationVerified = false;
    }],
  ]) {
    const f = fixture();
    const authority = structuredClone(f.authority);
    alter(authority);
    const result = verifyFullResearchQualificationReceipt(f.receipt, {
      ...f.context,
      resolveCampaignReleaseAuthority: () => authority,
    });
    assert.ok(result.blockers.includes(blocker), JSON.stringify(result.blockers));
  }
});

test('qualification rejects authentic but stale or future live provider canaries', () => {
  for (const [label, observedAt] of [
    ['stale', '2026-07-15T08:00:00.000Z'],
    ['future', '2026-07-15T09:01:00.000Z'],
  ]) {
    const f = fixture();
    const result = verifyFullResearchQualificationReceipt(f.receipt, {
      ...f.context,
      researchAuthorProviderCanaryReceipt: canary(
        f.context.researchAuthorCapabilityReceipt,
        `${label}-current-author`,
        observedAt,
      ),
    });
    assert.ok(result.blockers.includes(
      'golden_micro_campaign_research_author_provider_canary_invalid',
    ), JSON.stringify(result.blockers));
  }
});

test('self-signed, hash-tampered, missing live-canary and unverifiable current-release receipts fail closed', () => {
  const f = fixture();
  const tampered = structuredClone(f.receipt);
  tampered.paperId = 'attacker-paper';
  assert.ok(verifyFullResearchQualificationReceipt(tampered, f.context).blockers.includes(
    'golden_micro_campaign_qualification_receipt_hash_invalid',
  ));

  const attackerPair = crypto.generateKeyPairSync('ed25519');
  const { signature: _signature, fullResearchQualificationReceiptHash: _hash, ...unsigned } = f.receipt;
  const attackerSignature = crypto.sign(
    null,
    Buffer.from(hashRecord('FullResearchQualificationSigningPayload', unsigned), 'utf8'),
    attackerPair.privateKey,
  ).toString('base64');
  const attackerSigned = { ...unsigned, signature: attackerSignature };
  const attackerReceipt = {
    ...attackerSigned,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', attackerSigned),
  };
  assert.ok(verifyFullResearchQualificationReceipt(attackerReceipt, f.context).blockers.includes(
    'golden_micro_campaign_qualification_signature_invalid',
  ));
  assert.ok(verifyFullResearchQualificationReceipt(f.receipt, {
    ...f.context,
    researchAuthorProviderCanaryReceipt: null,
  }).blockers.includes('golden_micro_campaign_research_author_provider_canary_invalid'));
  assert.ok(verifyFullResearchQualificationReceipt(f.receipt, {
    ...f.context,
    resolveCampaignReleaseAuthority: () => { throw new Error('store unavailable'); },
  }).blockers.includes('golden_micro_campaign_release_authority_verification_failed'));
});

function qualificationEnvelopeContext(f, overrides = {}) {
  return {
    now: NOW,
    campaignReleaseAuthority: f.authority,
    expectedPaperId: f.receipt.paperId,
    expectedProposalHash: f.receipt.proposalHash,
    expectedPolicyAuthorizationHash: f.receipt.policyAuthorizationHash,
    expectedSeedBindingHash: f.receipt.seedBindingHash,
    verifyQualificationSignature: f.context.verifyQualificationSignature,
    ...overrides,
  };
}

function verifyEnvelope(f, receipt = f.receipt, overrides = {}) {
  return verifyFullResearchQualificationReceiptEnvelope(
    receipt,
    qualificationEnvelopeContext(f, overrides),
  );
}

test('qualification envelope verifies its complete release binding and fails closed per guard', () => {
  const valid = fixture();
  const accepted = verifyEnvelope(valid);
  assert.equal(accepted.ready, true, JSON.stringify(accepted.blockers));
  assert.equal(verifyProductionFullResearchQualificationReceiptEnvelope(
    valid.receipt,
    qualificationEnvelopeContext(valid),
  ).ready, false);
  assert.equal(accepted.signatureVerified, true);
  assert.equal(accepted.timeWindowVerified, true);
  assert.equal(accepted.releasePointerVerified, true);
  assert.equal(accepted.remainingValidityMs, 23 * 60 * 60 * 1000);

  const receiptAttacks = [
    ['external_qualification_receipt_shape_invalid', (r) => { r.version = 2; return r; }],
    ['external_qualification_receipt_shape_invalid', (r) => { r.kind = 'WrongReceipt'; return r; }],
    ['external_qualification_receipt_shape_invalid', (r) => { r.status = 'blocked'; return r; }],
    ['external_qualification_receipt_shape_invalid', (r) => { r.externalActionPerformed = false; return r; }],
    ['external_qualification_independent_hypothesis_prior_art_qualification_invalid', (r) => {
      r.independentHypothesisPriorArtReviewVerified = false; return r;
    }],
    ['external_qualification_runtime_image_reproducibility_binding_invalid', (r) => {
      delete r.runtimeImageReproducibilityReceiptHash; return r;
    }],
    ['external_qualification_receipt_outside_time_window', (r) => {
      r.issuedAt = 'not-a-time'; return r;
    }],
    ['external_qualification_receipt_outside_time_window', (r) => {
      r.expiresAt = r.issuedAt; return r;
    }],
    ['external_qualification_receipt_outside_time_window', (r) => {
      r.expiresAt = '2026-07-16T08:00:00.001Z'; return r;
    }],
    ['external_qualification_release_scope_not_eligible', (r) => {
      r.qualificationScope = 'bounded-golden-capability-v1'; return r;
    }],
    ['external_qualification_manuscript_release_proof_mismatch', (r) => {
      r[MANUSCRIPT_RELEASE_PROOF_FIELDS[0]] = HASH('unrelated-proof'); return r;
    }],
    ['external_qualification_signature_invalid', (r) => { r.signer.role = 'author'; return r; }],
    ['external_qualification_signature_invalid', (r) => { r.signer.algorithm = 'rsa'; return r; }],
  ];
  for (const [blocker, mutation] of receiptAttacks) {
    const f = fixture();
    const result = verifyEnvelope(f, resign(f, mutation));
    assert.ok(result.blockers.includes(blocker), `${blocker}: ${JSON.stringify(result.blockers)}`);
  }

  {
    const f = fixture();
    const invalidHash = structuredClone(f.receipt);
    invalidHash.fullResearchQualificationReceiptHash = 'not-a-hash';
    assert.ok(verifyEnvelope(f, invalidHash).blockers.includes(
      'external_qualification_receipt_hash_invalid',
    ));
  }

  for (const [blocker, overrides] of [
    ['external_qualification_verification_time_invalid', { now: 'not-a-time' }],
    ['external_qualification_receipt_outside_time_window', {
      now: new Date('2026-07-16T08:00:00.000Z'),
    }],
    ['external_qualification_current_release_pointer_mismatch', {
      expectedPaperId: 'other-paper',
    }],
    ['external_qualification_autonomous_preparation_binding_mismatch', {
      expectedProposalHash: HASH('other-proposal'),
    }],
    ['external_qualification_autonomous_preparation_binding_mismatch', {
      expectedPolicyAuthorizationHash: HASH('other-policy'),
    }],
    ['external_qualification_autonomous_preparation_binding_mismatch', {
      expectedSeedBindingHash: HASH('other-seed'),
    }],
    ['external_qualification_signature_invalid', { verifyQualificationSignature: null }],
    ['external_qualification_signature_invalid', { verifyQualificationSignature: () => false }],
  ]) {
    const f = fixture();
    const result = verifyEnvelope(f, f.receipt, overrides);
    assert.ok(result.blockers.includes(blocker), `${blocker}: ${JSON.stringify(result.blockers)}`);
  }

  const authorityAttacks = [
    (a) => { a.status = 'stale_release'; },
    (a) => { a.campaignStatus = 'running'; },
    (a) => { a.packageNodeStatus = 'pending'; },
    (a) => { a.campaignReleaseBundleHash = 'not-a-hash'; },
    (a) => { a.campaignId = 'other-campaign'; },
    (a) => { a.paperId = 'other-paper'; },
    (a) => { a.releaseBundle.campaignReleaseBundleHash = HASH('other-release'); },
    (a) => { a.releaseBundle.researchReport.promotionEligibility.status = 'blocked'; },
  ];
  for (const mutate of authorityAttacks) {
    const f = fixture();
    const authority = structuredClone(f.authority);
    mutate(authority);
    const result = verifyEnvelope(f, f.receipt, { campaignReleaseAuthority: authority });
    assert.ok(result.blockers.includes(
      'external_qualification_current_release_pointer_mismatch',
    ), JSON.stringify(result.blockers));
  }

  const preparationAttacks = [
    (a) => { delete a.releaseBundle.autonomousResearchReleaseBinding; },
    (a) => { a.releaseBundle.autonomousResearchReleaseBindingHash = HASH('other-binding'); },
    (a) => { a.releaseBundle.autonomousResearchReleaseBinding.campaignId = 'other-campaign'; },
    (a) => { a.releaseBundle.autonomousResearchReleaseBinding.paperId = 'other-paper'; },
    (a) => { a.releaseBundle.autonomousResearchReleaseBinding.campaignPlanHash = HASH('other-plan'); },
  ];
  for (const mutate of preparationAttacks) {
    const f = fixture();
    const authority = structuredClone(f.authority);
    mutate(authority);
    const result = verifyEnvelope(f, f.receipt, { campaignReleaseAuthority: authority });
    assert.ok(result.blockers.includes(
      'external_qualification_autonomous_preparation_binding_mismatch',
    ), JSON.stringify(result.blockers));
  }
});

test('qualification primitive null and trust-list paths remain fail closed', () => {
  assert.equal(providerPrincipalIndependenceAttestationSigningPayloadHash(null), null);
  assert.equal(fullResearchQualificationSigningPayloadHash(null), null);

  const empty = verifyFullResearchQualificationReceipt(null, { now: 'not-a-time' });
  assert.equal(empty.ready, false);
  assert.ok(empty.blockers.includes('golden_micro_campaign_qualification_receipt_shape_invalid'));
  assert.ok(empty.blockers.includes('golden_micro_campaign_release_authority_verifier_required'));

  const f = fixture();
  const trustedKeys = [{
    ...f.context.releaseAttestorInspection,
    status: 'active',
    revokedAt: null,
  }];
  const result = verifyFullResearchQualificationReceipt(f.receipt, {
    ...f.context,
    releaseAttestorInspection: { ready: true, trustedKeys },
    researchAuthorProviderCanaryReceipt: f.receipt.researchAuthorProviderCanaryReceipt,
    formalReviewerProviderCanaryReceipt: f.receipt.formalReviewerProviderCanaryReceipt,
  });
  assert.equal(result.ready, true, JSON.stringify(result.blockers));

  const rehashCapability = (record, kind, hashField) => {
    const payload = { ...record };
    delete payload[hashField];
    return Object.freeze({
      ...payload,
      [hashField]: hashRecord(kind, payload),
    });
  };
  for (const scenario of [
    Object.freeze({ name: 'native-account-identity-valid', mutate() {} }),
    Object.freeze({
      name: 'author-attestation-missing',
      mutate({ author }) { author.providerAccountIdentityAttested = false; },
    }),
    Object.freeze({
      name: 'reviewer-attestation-missing',
      mutate({ reviewer }) { reviewer.providerAccountIdentityAttested = false; },
    }),
    Object.freeze({
      name: 'reviewer-independence-missing',
      mutate({ reviewer }) { reviewer.providerAccountIndependenceVerified = false; },
    }),
    Object.freeze({
      name: 'author-account-hash-malformed',
      mutate({ author }) { author.providerAccountIdentityHash = 'not-a-hash'; },
    }),
    Object.freeze({
      name: 'reviewer-account-hash-malformed',
      mutate({ reviewer }) { reviewer.providerAccountIdentityHash = 'not-a-hash'; },
    }),
    Object.freeze({
      name: 'reviewer-author-binding-mismatch',
      mutate({ reviewer }) {
        reviewer.authorProviderAccountIdentityHash = HASH('unrelated-author-account');
      },
    }),
    Object.freeze({
      name: 'same-provider-account',
      mutate({ author, reviewer }) {
        reviewer.providerAccountIdentityHash = author.providerAccountIdentityHash;
      },
    }),
  ]) {
    const native = fixture();
    const nativeReceipt = resign(native, (receipt) => {
      const author = {
        ...receipt.researchAuthorCapabilityReceipt,
        providerAccountIdentityAttested: true,
        providerAccountIdentityHash: HASH('native-author-account'),
      };
      const reviewer = {
        ...receipt.formalReviewerCapabilityReceipt,
        providerAccountIdentityAttested: true,
        providerAccountIndependenceVerified: true,
        providerAccountIdentityHash: HASH('native-reviewer-account'),
        authorProviderAccountIdentityHash: HASH('native-author-account'),
      };
      scenario.mutate({ author, reviewer });
      receipt.researchAuthorCapabilityReceipt = rehashCapability(
        author,
        'CodexResearchAuthorCapabilityReceipt',
        'codexResearchAuthorCapabilityReceiptHash',
      );
      receipt.formalReviewerCapabilityReceipt = rehashCapability(
        reviewer,
        'CodexFormalReviewerCapabilityReceipt',
        'codexFormalReviewerCapabilityReceiptHash',
      );
      receipt.providerPrincipalIndependenceAttestation = null;
      return receipt;
    });
    const nativeResult = verifyFullResearchQualificationReceipt(nativeReceipt, {
      ...native.context,
      researchAuthorCapabilityReceipt: nativeReceipt.researchAuthorCapabilityReceipt,
      formalReviewerCapabilityReceipt: nativeReceipt.formalReviewerCapabilityReceipt,
    });
    assert.equal(nativeResult.ready, true,
      `${scenario.name}: ${JSON.stringify(nativeResult.blockers)}`);
  }

  for (const scenario of [
    Object.freeze({
      name: 'release-signature-verifier-missing',
      blocker: 'golden_micro_campaign_release_attestation_signature_invalid',
      context: Object.freeze({ verifyReleaseAttestation: null }),
      mutate() {},
    }),
    Object.freeze({
      name: 'release-signature-rejected',
      blocker: 'golden_micro_campaign_release_attestation_signature_invalid',
      context: Object.freeze({ verifyReleaseAttestation: () => false }),
      mutate() {},
    }),
    Object.freeze({
      name: 'release-valid-from-malformed',
      blocker: 'golden_micro_campaign_release_attestation_outside_time_window',
      context: Object.freeze({}),
      mutate(authority) {
        authority.releaseBundle.researchExecutionReleaseAttestation.validFrom = 'not-a-time';
      },
    }),
    Object.freeze({
      name: 'release-expiry-malformed',
      blocker: 'golden_micro_campaign_release_attestation_outside_time_window',
      context: Object.freeze({}),
      mutate(authority) {
        authority.releaseBundle.researchExecutionReleaseAttestation.expiresAt = 'not-a-time';
      },
    }),
    Object.freeze({
      name: 'release-not-yet-valid',
      blocker: 'golden_micro_campaign_release_attestation_outside_time_window',
      context: Object.freeze({}),
      mutate(authority) {
        authority.releaseBundle.researchExecutionReleaseAttestation.validFrom =
          '2026-07-15T09:30:00.000Z';
      },
    }),
    Object.freeze({
      name: 'release-attestor-mismatch',
      blocker: 'golden_micro_campaign_release_attestation_signer_mismatch',
      context: Object.freeze({}),
      mutate(authority) {
        authority.releaseBundle.researchExecutionReleaseAttestation.keyVersion =
          'untrusted-release-key-version';
      },
    }),
  ]) {
    const release = fixture();
    const authority = structuredClone(release.authority);
    scenario.mutate(authority);
    const verification = verifyFullResearchQualificationReceipt(release.receipt, {
      ...release.context,
      resolveCampaignReleaseAuthority: () => authority,
      ...scenario.context,
    });
    assert.ok(verification.blockers.includes(scenario.blocker),
      `${scenario.name}: ${JSON.stringify(verification.blockers)}`);
  }
});
