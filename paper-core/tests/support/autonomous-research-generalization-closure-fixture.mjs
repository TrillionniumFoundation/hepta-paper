import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  importAutonomousSubmissionContractForTest,
  importExternalResearchQualificationAttestationForTest,
  importExternalResearchQualificationEvidenceForTest,
  importExternalResearchQualificationPolicyForTest,
  importFullResearchQualificationForTest,
  importLocalAutonomousVenueComplianceInspectorForTest,
  importResearchClosureReceiptContractForTest,
} from './production-experiment-closure-test-seam.mjs';
import {
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
} from '../../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import {
  FIXED_TIME,
  PRODUCTION_VENUE_TEMPLATE_PATH,
  PRODUCTION_VENUE_TEMPLATE_SOURCE,
  digest,
} from './autonomous-research-generalization-core-fixture.mjs';
import {
  genericManuscriptReleaseFixture,
} from './autonomous-research-generalization-release-fixture.mjs';
import {
  buildProductionCampaignReleaseClosureFixture,
} from './production-campaign-release-closure-fixture.mjs';
import { hashBytes, hashRecord } from '../../../workflow-kernel/record-hash.mjs';

const [
  { buildResearchClosureReceipt },
  { buildAutonomousSubmissionRequest },
  {
    buildIndependentExternalResearchQualificationVerificationEvidence,
    buildIndependentExternalResearchQualificationVerificationRequest,
    externalResearchQualificationPreparationBindingFromReleaseAuthority,
    independentExternalResearchQualificationResponseSigningPayloadHash,
  },
  { INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_VERSION },
  { fullResearchQualificationSigningPayloadHash },
  { createLocalAutonomousVenueComplianceInspector },
  { verifyIndependentExternalResearchQualificationVerificationEvidence },
] = await Promise.all([
  importResearchClosureReceiptContractForTest(),
  importAutonomousSubmissionContractForTest(),
  importExternalResearchQualificationEvidenceForTest(),
  importExternalResearchQualificationPolicyForTest(),
  importFullResearchQualificationForTest(),
  importLocalAutonomousVenueComplianceInspectorForTest(),
  importExternalResearchQualificationAttestationForTest(),
]);

const qualificationAttestorPair = crypto.generateKeyPairSync('ed25519');
const independentVerifierAttestorPair = crypto.generateKeyPairSync('ed25519');
const QUALIFICATION_ISSUED_AT = new Date(
  Date.parse(FIXED_TIME) + (60 * 1_000),
).toISOString();
const CLOSURE_TIME = new Date(
  Date.parse(FIXED_TIME) + (2 * 60 * 1_000),
).toISOString();
const qualificationSigner = Object.freeze({
  keyId: 'production-closure-qualification-key',
  keyVersion: 'v1',
  subjectId: 'production-closure-independent-attestor',
  organization: 'production-closure-independent-office',
  role: 'research_execution_release_attestor',
  algorithm: 'ed25519',
});
const independentVerifierSigner = Object.freeze({
  keyId: 'production-closure-independent-verifier-key',
  keyVersion: 'v1',
  subjectId: 'production-closure-independent-verifier',
  organization: 'production-closure-independent-verification-office',
  role: 'independent_external_research_qualification_verifier',
  algorithm: 'ed25519',
  status: 'active',
  effectiveFrom: FIXED_TIME,
  expiresAt: new Date(
    Date.parse(FIXED_TIME) + (24 * 60 * 60 * 1_000),
  ).toISOString(),
  revokedAt: null,
});
const independentVerifierConfiguration = Object.freeze({
  verifier: Object.freeze({
    serviceId: 'independent-external-qualification:production-closure-fixture',
  }),
  configurationIdentityHash:
    digest('production-closure-independent-verifier-configuration'),
  trustIdentityHash:
    digest('production-closure-independent-verifier-trust'),
  verifierServiceIdentityHash:
    digest('production-closure-independent-verifier-service'),
  verifierAttestor: independentVerifierSigner,
  verifierPublicKey: independentVerifierAttestorPair.publicKey,
});

export function qualificationSignatureVerifier({
  signingPayloadHash,
  signature,
  signer,
  signedAt,
} = {}) {
  if (JSON.stringify(signer) !== JSON.stringify(qualificationSigner)
    || signedAt !== QUALIFICATION_ISSUED_AT
    || typeof signingPayloadHash !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(signingPayloadHash)
    || typeof signature !== 'string' || !signature) return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(signingPayloadHash, 'utf8'),
      qualificationAttestorPair.publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch { return false; }
}

export function qualificationIndependentEvidenceVerifier({
  evidence,
  receipt,
  campaignReleaseAuthority,
  releaseBinding,
  verificationTime,
  qualificationInspection,
} = {}) {
  if (evidence?.independentExternalResearchQualificationVerificationEvidenceHash
      !== qualificationInspection?.independentVerificationEvidenceHash
    || JSON.stringify(evidence)
      !== JSON.stringify(qualificationInspection?.independentVerificationEvidence)
    || releaseBinding?.autonomousResearchReleaseBindingHash
      !== campaignReleaseAuthority?.releaseBundle
        ?.autonomousResearchReleaseBindingHash) return false;
  const preparation =
    externalResearchQualificationPreparationBindingFromReleaseAuthority(
      campaignReleaseAuthority,
    );
  return verifyIndependentExternalResearchQualificationVerificationEvidence(
    evidence,
    {
      receipt,
      campaignReleaseAuthority,
      preparation,
      configuration: independentVerifierConfiguration,
      verificationTime,
    },
  ).valid;
}

function productionIndependentQualificationEvidence({
  campaignReleaseAuthority,
  qualificationReceipt,
} = {}) {
  const preparation =
    externalResearchQualificationPreparationBindingFromReleaseAuthority(
      campaignReleaseAuthority,
    );
  const request =
    buildIndependentExternalResearchQualificationVerificationRequest({
      receipt: qualificationReceipt,
      campaignReleaseAuthority,
      preparation,
      verifierId: independentVerifierConfiguration.verifier.serviceId,
      verifiedAt: QUALIFICATION_ISSUED_AT,
    });
  const policy = request.verificationPolicy;
  const inspection = Object.freeze({
    version: 1,
    kind: 'FullResearchQualificationInspection',
    status: 'full_research_qualification_verified',
    ready: true,
    receiptAccepted: true,
    campaignId: qualificationReceipt.campaignId,
    paperId: qualificationReceipt.paperId,
    campaignReleaseBundleHash:
      qualificationReceipt.campaignReleaseBundleHash,
    qualificationReceiptHash:
      qualificationReceipt.fullResearchQualificationReceiptHash,
    runtimeImageReproducibilityReceiptHash:
      qualificationReceipt.runtimeImageReproducibilityReceiptHash,
    runtimeImageReproducibilityRequiredProfiles:
      qualificationReceipt.runtimeImageReproducibilityRequiredProfiles,
    runtimeImageReproducibilityDefinitionManifestHashes:
      qualificationReceipt.runtimeImageReproducibilityDefinitionManifestHashes,
    empiricalFamilyPluginPackageHash:
      qualificationReceipt.empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash:
      qualificationReceipt.empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash:
      qualificationReceipt.empiricalFamilyPluginStartupInspectionHash,
    activeEmpiricalProductionProfileHashes:
      qualificationReceipt.activeEmpiricalProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash:
      qualificationReceipt.runtimeImageReproducibilityActivePluginScopeHash,
    proposalHash: qualificationReceipt.proposalHash,
    policyAuthorizationHash: qualificationReceipt.policyAuthorizationHash,
    seedBindingHash: qualificationReceipt.seedBindingHash,
    qualificationScope: qualificationReceipt.qualificationScope,
    genericContentCanaryVerified:
      qualificationReceipt.genericContentCanaryVerified,
    independentHypothesisPriorArtReviewVerified: true,
    independentHypothesisPriorArtReceiptHash:
      qualificationReceipt.independentHypothesisPriorArtReceiptHash,
    verificationPolicyHash: request.verificationPolicyHash,
    structuredPriorArtEvidenceVerified: true,
    nativeFormalCertificateIntakeV4Verified: true,
    releaseBindingVersion: policy.releaseBindingVersion,
    launchMode: policy.launchMode,
    recursiveReleaseClosureRequired: policy.recursiveReleaseClosureRequired,
    recursiveReleaseClosureRequirementSatisfied: true,
    allowBoundedGoldenCapability: policy.allowBoundedGoldenCapability,
    blockers: Object.freeze([]),
  });
  const responsePayload = {
    version: INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_VERSION,
    kind: 'IndependentExternalResearchQualificationVerificationResponse',
    verifierId: request.verifierId,
    requestHash: request.requestHash,
    signedAt: QUALIFICATION_ISSUED_AT,
    signer: independentVerifierSigner,
    inspection,
    verificationPolicyHash: request.verificationPolicyHash,
  };
  const responseHash = hashRecord(
    'IndependentExternalResearchQualificationVerificationResponse',
    responsePayload,
  );
  const response = Object.freeze({
    ...responsePayload,
    responseHash,
    signature: crypto.sign(
      null,
      Buffer.from(
        independentExternalResearchQualificationResponseSigningPayloadHash(
          responsePayload,
        ),
        'utf8',
      ),
      independentVerifierAttestorPair.privateKey,
    ).toString('base64'),
  });
  return buildIndependentExternalResearchQualificationVerificationEvidence({
    request,
    response,
    configurationIdentityHash:
      independentVerifierConfiguration.configurationIdentityHash,
    trustIdentityHash:
      independentVerifierConfiguration.trustIdentityHash,
    verifierServiceIdentityHash:
      independentVerifierConfiguration.verifierServiceIdentityHash,
  });
}

export function productionQualificationInspectionFixture({
  campaignReleaseAuthority,
  releaseBinding,
} = {}) {
  const proofFields = Object.freeze([
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
  const proof = Object.fromEntries(proofFields.map((field) => (
    [field, releaseBinding[field]]
  )));
  const unsignedReceiptPayload = {
    version: 1,
    kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
    status: 'full_research_golden_micro_campaign_qualified',
    campaignId: campaignReleaseAuthority.campaignId,
    paperId: campaignReleaseAuthority.paperId,
    campaignReleaseBundleHash:
      campaignReleaseAuthority.campaignReleaseBundleHash,
    proposalHash: releaseBinding.proposalHash,
    policyAuthorizationHash: releaseBinding.policyAuthorizationHash,
    seedBindingHash: releaseBinding.seedBindingHash,
    qualificationScope: releaseBinding.qualificationScope,
    genericContentCanaryVerified: true,
    independentHypothesisPriorArtReviewVerified: true,
    independentHypothesisPriorArtReceiptHash:
      releaseBinding.priorArtEvidenceReceiptHash,
    priorArtEvidenceReceipt: releaseBinding.priorArtEvidenceReceipt,
    runtimeImageReproducibilityReceiptHash: digest(
      `${campaignReleaseAuthority.campaignId}:runtime-reproducibility`,
    ),
    runtimeImageReproducibilityRequiredProfiles:
      REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
    runtimeImageReproducibilityDefinitionManifestHashes: Object.freeze(
      Object.fromEntries(REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES.map(
        (profile) => [profile, digest(`runtime-definition:${profile}`)],
      )),
    ),
    empiricalFamilyPluginPackageHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginStartupInspectionHash,
    activeEmpiricalProductionProfileHashes:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .activeProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .runtimeImageReproducibilityActivePluginScopeHash,
    ...proof,
    venueProfileSelectionHash: releaseBinding.venueProfileSelectionHash,
    submissionMetadataReceiptHash:
      releaseBinding.submissionMetadataReceiptHash,
    issuedAt: QUALIFICATION_ISSUED_AT,
    expiresAt: new Date(
      Date.parse(QUALIFICATION_ISSUED_AT) + (12 * 60 * 60 * 1_000),
    )
      .toISOString(),
    signer: qualificationSigner,
    externalActionPerformed: true,
  };
  const signingPayloadHash = fullResearchQualificationSigningPayloadHash(
    unsignedReceiptPayload,
  );
  const receiptPayload = {
    ...unsignedReceiptPayload,
    signature: crypto.sign(
      null,
      Buffer.from(signingPayloadHash, 'utf8'),
      qualificationAttestorPair.privateKey,
    ).toString('base64'),
  };
  const qualificationReceipt = Object.freeze({
    ...receiptPayload,
    fullResearchQualificationReceiptHash: hashRecord(
      'FullResearchGoldenMicroCampaignQualificationReceipt',
      receiptPayload,
    ),
  });
  if (!qualificationSignatureVerifier({
    signingPayloadHash: fullResearchQualificationSigningPayloadHash(
      qualificationReceipt,
    ),
    signature: qualificationReceipt.signature,
    signer: qualificationReceipt.signer,
    signedAt: qualificationReceipt.issuedAt,
  })) {
    throw new Error('production_closure_qualification_signature_invalid');
  }
  const independentVerificationEvidence =
    productionIndependentQualificationEvidence({
      campaignReleaseAuthority,
      qualificationReceipt,
    });
  const inspectionPayload = {
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
    externalVerificationRequestHash:
      independentVerificationEvidence.request.requestHash,
    independentVerificationEvidenceHash:
      independentVerificationEvidence
        .independentExternalResearchQualificationVerificationEvidenceHash,
    independentVerificationEvidence,
    campaignId: campaignReleaseAuthority.campaignId,
    paperId: campaignReleaseAuthority.paperId,
    campaignReleaseBundleHash:
      campaignReleaseAuthority.campaignReleaseBundleHash,
    qualificationReceiptHash:
      qualificationReceipt.fullResearchQualificationReceiptHash,
    qualificationScope: releaseBinding.qualificationScope,
    genericContentCanaryVerified: true,
    ...proof,
    venueProfileSelectionHash: releaseBinding.venueProfileSelectionHash,
    submissionMetadataReceiptHash:
      releaseBinding.submissionMetadataReceiptHash,
    qualificationReceipt,
  };
  return Object.freeze({
    ...inspectionPayload,
    fullResearchQualificationInspectionHash: hashRecord(
      'FullResearchQualificationInspection',
      inspectionPayload,
    ),
  });
}

function productionClosureMainTex() {
  return [
    '\\documentclass[11pt]{article}',
    `\\input{${PRODUCTION_VENUE_TEMPLATE_PATH}}`,
    '% HEPTA_BIBLIOGRAPHY_STYLE inline-evidence-v1',
    '% HEPTA_CITATION_STYLE evidence-inline-v1',
    '\\usepackage{amsmath,amssymb,amsthm,graphicx}',
    '\\newtheorem{theorem}{Theorem}',
    '\\title{Agent-authored bounded result}',
    '\\author{Anonymous submission}',
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    '\\section{Abstract}',
    'This manuscript reports only claims bound to machine-verifiable evidence.',
    '\\section{Methods}',
    'The signed treatment, baseline, ablation, dataset, estimand, and falsifier were fixed before execution.',
    'Every observation was replayed under the same hash-bound analysis plan.',
    '\\section{Results}',
    'The registered evidence capsule contains the exact original and replay receipts used by this report.',
    '\\section{Limitations}',
    'Finite retrieval and bounded execution do not establish open-world novelty or unrestricted scientific truth.',
    '\\section*{Keywords}',
    'autonomous research; evidence binding; ml-algorithm-benchmark',
    '\\section*{Automated authorship and model use}',
    'This manuscript was produced by the registered autonomous research system and its bound model executions.',
    '\\section*{Conflict of interest}',
    'The author declares no competing interests.',
    '\\section*{Funding}',
    'No external funding was used.',
    '\\section*{Data availability}',
    'The evidence capsule contains the bound data artifacts.',
    '\\section*{Code availability}',
    'The source archive contains the bound implementation.',
    '\\end{document}',
    '',
  ].join('\n');
}

function writeFixtureBytes(root, relative, bytes, role = 'source_file') {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
  return Object.freeze({
    path: relative,
    role,
    required: true,
    hash: hashBytes(fs.readFileSync(destination)),
    bytes: fs.statSync(destination).size,
    mode: fs.statSync(destination).mode & 0o777,
    identityHash: null,
  });
}

function runFixtureCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`production_closure_fixture_command_failed:${command}:${
      String(result.stderr || '').slice(0, 2_000)
    }`);
  }
  return result;
}

function materializeProductionClosurePackage({
  runtimeRoot,
  mainSource,
  manuscript,
} = {}) {
  const artifactBaseRoot = path.join(runtimeRoot, 'artifacts');
  const sourceRoot = path.join(runtimeRoot, 'source');
  const buildRoot = path.join(runtimeRoot, 'build');
  fs.mkdirSync(artifactBaseRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(buildRoot, { recursive: true, mode: 0o700 });
  const sourceRows = [
    writeFixtureBytes(
      sourceRoot,
      'main.tex',
      Buffer.from(mainSource, 'utf8'),
      'main_tex',
    ),
    writeFixtureBytes(
      sourceRoot,
      'Formal.lean',
      Buffer.from('theorem fixture_truth : True := by trivial\n', 'utf8'),
    ),
    writeFixtureBytes(
      sourceRoot,
      'AUTONOMOUS_MANUSCRIPT_IR.json',
      Buffer.from(JSON.stringify(manuscript.manuscriptIr), 'utf8'),
    ),
    writeFixtureBytes(
      sourceRoot,
      'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
      Buffer.from(JSON.stringify(manuscript.sourceDraft), 'utf8'),
    ),
    writeFixtureBytes(
      sourceRoot,
      'AUTONOMOUS_PRIOR_ART_EVIDENCE.json',
      Buffer.from(JSON.stringify(manuscript.priorArtReceipt), 'utf8'),
    ),
    writeFixtureBytes(
      sourceRoot,
      'AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json',
      Buffer.from(JSON.stringify(manuscript.seedBundle), 'utf8'),
    ),
    writeFixtureBytes(
      sourceRoot,
      'AUTONOMOUS_SUBMISSION_METADATA.json',
      Buffer.from(JSON.stringify(manuscript.submissionMetadataReceipt), 'utf8'),
    ),
    writeFixtureBytes(
      sourceRoot,
      'AUTONOMOUS_VENUE_REQUIREMENT_IR.json',
      Buffer.from(JSON.stringify(manuscript.venueRequirementIr), 'utf8'),
    ),
    writeFixtureBytes(
      sourceRoot,
      PRODUCTION_VENUE_TEMPLATE_PATH,
      Buffer.from(PRODUCTION_VENUE_TEMPLATE_SOURCE, 'utf8'),
    ),
    writeFixtureBytes(
      sourceRoot,
      'EXPERIMENT_REPLAY_RECEIPT.json',
      Buffer.from(JSON.stringify(manuscript.experimentReplayReceipt), 'utf8'),
    ),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const sourceZipPath = path.join(artifactBaseRoot, 'source.zip');
  runFixtureCommand('zip', [
    '-X', '-D', '-q', sourceZipPath,
    ...sourceRows.map((row) => row.path),
  ], { cwd: sourceRoot });
  const buildPdf = (name) => {
    const outputRoot = path.join(buildRoot, name);
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    runFixtureCommand('pdflatex', [
      '-interaction=nonstopmode',
      '-halt-on-error',
      `-output-directory=${outputRoot}`,
      path.join(sourceRoot, 'main.tex'),
    ], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        SOURCE_DATE_EPOCH: '1784390400',
        FORCE_SOURCE_DATE: '1',
      },
    });
    return path.join(outputRoot, 'main.pdf');
  };
  const compiledPdf = buildPdf('authoritative');
  const rebuiltPdf = buildPdf('independent');
  const compiledRelative = 'compiled.pdf';
  const rebuiltRelative = 'independent-rebuilt.pdf';
  fs.copyFileSync(compiledPdf, path.join(artifactBaseRoot, compiledRelative));
  fs.copyFileSync(rebuiltPdf, path.join(artifactBaseRoot, rebuiltRelative));
  const artifact = (relative, role) => {
    const bytes = fs.readFileSync(path.join(artifactBaseRoot, relative));
    return Object.freeze({
      role,
      path: relative,
      hash: hashBytes(bytes),
      bytes: bytes.length,
    });
  };
  const files = Object.freeze([
    artifact('source.zip', 'generated_source_zip'),
    artifact(compiledRelative, 'compiled_pdf'),
    artifact(rebuiltRelative, 'independent_rebuilt_pdf'),
  ]);
  return Object.freeze({
    artifactBaseRoot,
    sourceRoot,
    sourceRows: Object.freeze(sourceRows),
    files,
    sourceZipHash: files.find((file) => file.role === 'generated_source_zip').hash,
    compiledPdfHash: files.find((file) => file.role === 'compiled_pdf').hash,
    independentRebuiltPdfHash:
      files.find((file) => file.role === 'independent_rebuilt_pdf').hash,
  });
}

export function productionResearchClosureFixture({
  paperId = 'paper-production-research-closure',
  campaignId = 'campaign-production-research-closure',
  campaignPlanHash = digest('production-research-closure-plan'),
  portalConfigurationHash = digest('production-research-closure-portal'),
  runtimeRoot: suppliedRuntimeRoot = null,
} = {}) {
  const ownsRuntimeRoot = suppliedRuntimeRoot === null;
  const runtimeRoot = suppliedRuntimeRoot || fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-production-research-closure-'),
  );
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const mainSource = productionClosureMainTex();
  const baseManuscript = genericManuscriptReleaseFixture({
    paperId,
    campaignId,
    campaignPlanHash,
    externalSubmission: true,
    renderedManuscriptHash: hashBytes(Buffer.from(mainSource, 'utf8')),
  });
  const materialized = materializeProductionClosurePackage({
    runtimeRoot,
    mainSource,
    manuscript: baseManuscript,
  });
  const sourceTreeManifestPayload = {
    version: 1,
    kind: 'ScopedSourceTreeManifest',
    status: 'scoped_source_tree_verified',
    sourcePackageContractHash: digest(`${paperId}:source-package-contract`),
    fileCount: materialized.sourceRows.length,
    totalBytes: materialized.sourceRows.reduce(
      (total, row) => total + row.bytes,
      0,
    ),
    rows: materialized.sourceRows,
    blockers: Object.freeze([]),
  };
  const sourceTreeManifest = Object.freeze({
    ...sourceTreeManifestPayload,
    sourceTreeManifestHash: hashRecord(
      'ScopedSourceTreeManifest',
      sourceTreeManifestPayload,
    ),
  });
  const campaignRelease = buildProductionCampaignReleaseClosureFixture({
    paperId,
    campaignId,
    campaignPlanHash,
    createdAt: FIXED_TIME,
    manuscript: baseManuscript,
    sourceTreeManifest,
    sourceWorkspace: materialized.sourceRoot,
    artifactBaseRoot: materialized.artifactBaseRoot,
    packageFiles: materialized.files,
  });
  const manuscript = campaignRelease.manuscript;
  const releaseBinding = campaignRelease.releaseBinding;
  const packageOutput = campaignRelease.packageOutput;
  const promotionCandidate = campaignRelease.promotionCandidate;
  const releaseBundle = campaignRelease.releaseBundle;
  const campaignReleaseAuthority = campaignRelease.campaignReleaseAuthority;
  const releaseAuthorityVerification =
    campaignRelease.campaignReleaseAuthorityVerification;
  if (!releaseAuthorityVerification.valid) {
    throw new Error(
      `production_research_closure_release_authority_invalid:${
        releaseAuthorityVerification.blockers.join(',')
      }`,
    );
  }
  const qualificationInspection = productionQualificationInspectionFixture({
    campaignReleaseAuthority,
    releaseBinding,
  });
  const venueComplianceReceipt = createLocalAutonomousVenueComplianceInspector({
    runtimeRoot,
  }).inspect({
    campaignReleaseAuthority,
    venueProfileSelection: manuscript.venueProfileSelection,
  });
  const venueRequirementObservations =
    venueComplianceReceipt.venueRequirementObservations;
  const researchClosureReceipt = buildResearchClosureReceipt({
    campaignReleaseAuthority,
    qualificationInspection,
    venueComplianceReceipt,
    closedAt: CLOSURE_TIME,
  }, {
    verifyQualificationSignature: qualificationSignatureVerifier,
    verifyIndependentQualificationEvidence:
      qualificationIndependentEvidenceVerifier,
  });
  const submissionRequest = buildAutonomousSubmissionRequest({
    campaignId,
    paperId,
    venueProfileSelection: manuscript.venueProfileSelection,
    campaignReleaseAuthority,
    qualificationInspection,
    venueComplianceReceipt,
    portalConfigurationHash,
    requestedAt: CLOSURE_TIME,
    researchClosureReceipt,
    requireResearchClosure: true,
    verifyQualificationSignature: qualificationSignatureVerifier,
    verifyIndependentQualificationEvidence:
      qualificationIndependentEvidenceVerifier,
  });
  return Object.freeze({
    runtimeRoot,
    mainSource,
    qualificationIssuedAt: QUALIFICATION_ISSUED_AT,
    closureTime: CLOSURE_TIME,
    cleanup() {
      if (ownsRuntimeRoot) fs.rmSync(runtimeRoot, { recursive: true, force: true });
    },
    manuscript,
    releaseBinding,
    sourceTreeManifest,
    packageOutput,
    promotionCandidate,
    campaignRelease,
    releaseBundle,
    campaignReleaseAuthority,
    campaignReleaseAuthorityVerification: releaseAuthorityVerification,
    qualificationSignatureVerifier,
    qualificationIndependentEvidenceVerifier,
    qualificationInspection,
    sourceEvidenceBundle: venueComplianceReceipt.sourceEvidenceBundle,
    sourceInspectionReceipt:
      venueComplianceReceipt.sourceEvidenceBundle.sourceInspectionReceipt,
    venueRequirementObservations,
    venueComplianceReceipt,
    researchClosureReceipt,
    submissionRequest,
  });
}
