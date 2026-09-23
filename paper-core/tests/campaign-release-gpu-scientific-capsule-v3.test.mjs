import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import {
  verifyCampaignReleaseGpuScientificCapsuleDirectorySync,
} from '../../paper-adapters/build-package/research-evidence-capsule-gpu-scientific.mjs';
import {
  createGpuScientificCampaignPromotionAuthorityVerifier,
  verifyGpuScientificCampaignQualificationEvidenceAuthority,
} from '../../paper-adapters/automation/gpu-scientific-campaign-promotion-authority-verifier.mjs';
import { createCampaignReleasePackager } from '../../paper-adapters/automation/campaign-release-packager.mjs';
import {
  freezeCampaignReleaseGpuScientificAuthorityTrustStore,
  verifyPackagedGpuScientificAuthorityFreshness,
} from '../../paper-adapters/automation/campaign-release-gpu-scientific-authority-freshness.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { bootstrapAutomationContext } from '../../paper-composition/bootstrap/automation-context-bootstrap.mjs';
import {
  convergeAutonomousSubmissionHandoff,
} from '../../paper-composition/bootstrap/autonomous-submission-handoff-migration-composition.mjs';
import {
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS,
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH,
  buildGpuScientificArtifactBodyArchiveManifest,
} from '../../paper-domain/automation/gpu-scientific-artifact-body-archive-contract.mjs';
import {
  buildCanonicalGpuScientificCampaignExecutionPlan,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
  buildPdePoisson2dGpuProducerSpecification,
} from '../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs';
import {
  buildPdePoisson2dOfflineReplayInput,
} from '../../paper-adapters/build-package/gpu-scientific-artifact-body-offline-replay.mjs';
import {
  GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
  buildGpuScientificCampaignProductionQualificationAuthority,
  buildGpuScientificCampaignQualificationEvidence,
  buildGpuScientificCampaignQualificationRequest,
  buildGpuScientificCampaignSameDeviceReplayReceipt,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import {
  CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE,
  CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_PATH,
  CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE,
} from '../../paper-domain/automation/campaign-release-gpu-scientific-evidence-capsule-contract.mjs';
import {
  buildCampaignReleaseEvidenceCapsuleManifest,
  verifyCampaignReleaseEvidenceCapsuleManifest,
  verifyCampaignReleaseEvidenceCapsulePackageOutput,
} from '../../paper-domain/automation/campaign-release-evidence-capsule-contract.mjs';
import {
  buildCampaignReleaseExecutionAttestationUnsignedPayload,
  campaignReleaseExecutionAttestationDocumentFileHash,
  campaignReleaseExecutionAttestationSigningPayloadHash,
  finalizeCampaignReleaseExecutionAttestation,
  verifyCampaignReleaseExecutionAttestationStructure,
} from '../../paper-domain/automation/campaign-release-execution-attestation-contract.mjs';
import {
  campaignReleasePackageOutputFilesValid,
} from '../../paper-domain/automation/campaign-release-package-output-policy.mjs';
import {
  buildPublicAuthorityTrustSnapshot,
} from '../../paper-domain/automation/public-authority-trust-snapshot-contract.mjs';
import {
  verifyGpuScientificReleaseAuthorityFreshnessReceipt,
} from '../../paper-domain/automation/gpu-scientific-release-authority-freshness-receipt-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const RELEASE_TIME = '2026-08-15T00:00:00.000Z';
const REVOKED_RELEASE_TIME = '2026-08-17T00:00:00.000Z';
const EXPIRED_RELEASE_TIME = '2026-08-21T00:00:00.000Z';
const GPU_SELECTOR = 'GPU-12345678-1234-1234-1234-123456789abc';
const H = (label) => hashRecord('CampaignReleaseGpuCapsuleV3Test', { label });
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function discreteReferenceBytes(gridSize, modes) {
  const spacing = 1 / (gridSize + 1);
  const bytes = Buffer.alloc(gridSize * gridSize * 8);
  for (let row = 0; row < gridSize; row += 1) {
    const y = (row + 1) * spacing;
    for (let column = 0; column < gridSize; column += 1) {
      const x = (column + 1) * spacing;
      let value = 0;
      for (const { amplitude, kx, ky } of modes) {
        const basis = Math.sin(kx * Math.PI * x) * Math.sin(ky * Math.PI * y);
        const continuousEigenvalue = Math.PI ** 2 * (kx ** 2 + ky ** 2);
        const discreteEigenvalue = 4 / spacing ** 2 * (
          Math.sin(kx * Math.PI * spacing / 2) ** 2
          + Math.sin(ky * Math.PI * spacing / 2) ** 2
        );
        value += amplitude * continuousEigenvalue / discreteEigenvalue * basis;
      }
      bytes.writeDoubleLE(value, (row * gridSize + column) * 8);
    }
  }
  return bytes;
}

function semanticArchiveBodies() {
  const executionPlan = buildCanonicalGpuScientificCampaignExecutionPlan({
    campaignId: 'gpu-v3-campaign',
    paperId: 'gpu-v3-paper',
    gpuDeviceSelector: GPU_SELECTOR,
    absoluteExecutionDeadlineEpochMs: 2_000_000_000_000,
  });
  const task = executionPlan.tasks[1];
  const producerSpecification = buildPdePoisson2dGpuProducerSpecification();
  const requestHash = H('pde-request');
  const pdeSolutions = new Map([31, 63, 127].map((gridSize) => [
    gridSize,
    discreteReferenceBytes(
      gridSize,
      producerSpecification.equation.manufacturedModes,
    ),
  ]));
  const pdeArtifacts = [31, 63, 127].map((gridSize) => ({
    gridSize,
    relativePath: `solutions/n${gridSize}.f64le`,
    encoding: PDE_POISSON_2D_GPU_ARTIFACT_ENCODING,
    elements: gridSize * gridSize,
    bytes: pdeSolutions.get(gridSize).length,
    sha256: hashBytes(pdeSolutions.get(gridSize)),
  }));
  const pdeReplayInput = buildPdePoisson2dOfflineReplayInput({
    producerSpecification,
    artifactManifest: {
      requestHash,
      producerSpecificationHash:
        producerSpecification.pdePoisson2dGpuProducerSpecificationHash,
      pdePoisson2dGpuArtifactManifestHash: H('pde-artifacts'),
      artifacts: pdeArtifacts,
    },
  });
  const expectedTensors = task.modelIr.layers.flatMap((layer) => [
    { name: `${layer.layerId}.weight`, shape: [layer.outputUnits, layer.inputUnits] },
    { name: `${layer.layerId}.bias`, shape: [layer.outputUnits] },
  ]).sort((left, right) => left.name.localeCompare(right.name));
  const chunks = [];
  const tensors = expectedTensors.map(({ name, shape }) => {
    const bytes = Buffer.alloc(
      shape.reduce((product, dimension) => product * dimension, 4),
    );
    chunks.push(bytes);
    return {
      name,
      dtype: 'float32',
      shape,
      byteLength: bytes.length,
      sha256: hashBytes(bytes),
    };
  });
  const bundle = Buffer.concat(chunks);
  const predictedClass = task.trainingDataset.labels.map(() => 0);
  const accuracy = predictedClass.reduce((total, predicted, index) => (
    total + Number(predicted === task.trainingDataset.labels[index])
  ), 0) / task.trainingDataset.sampleCount;
  const crossEntropy = Math.log(task.modelIr.classCount);
  const finalMetrics = {
    accuracy,
    crossEntropy,
    gradientNorm: 0,
    initialCrossEntropy: crossEntropy,
  };
  const common = {
    trainingRunId: task.trainingRunId,
    modelIrHash: task.modelIr.deepLearningModelIrHash,
    trainingDatasetManifestHash:
      task.trainingDataset.deepLearningTrainingDatasetManifestHash,
  };
  return new Map([
    ['pde_solution_n31', pdeSolutions.get(31)],
    ['pde_solution_n63', pdeSolutions.get(63)],
    ['pde_solution_n127', pdeSolutions.get(127)],
    ['pde_producer_diagnostics', jsonBytes({
      version: 1,
      kind: 'CanonicalCupyPoisson2dProducerDiagnostics',
      requestHash,
      visibleGpuUuid: GPU_SELECTOR,
      observations: [31, 63, 127].map((gridSize) => ({
        gridSize,
        iterations: 1,
        relativeContinuousL2Error: 0,
        relativeDiscreteResidual: 0,
      })),
      scientificAuthority: 'non-authoritative-self-report-v1',
    })],
    ['pde_offline_replay_input', jsonBytes(pdeReplayInput)],
    ['deep_learning_model_specification', jsonBytes({
      version: 1,
      kind: 'DeepLearningModelSpecification',
      profile: task.profile,
      modelIr: task.modelIr,
    })],
    ['deep_learning_training_dataset', jsonBytes(task.trainingDataset)],
    ['deep_learning_tensor_bundle', bundle],
    ['deep_learning_training_predictions', jsonBytes({
      version: 1,
      kind: 'DeepLearningTrainingPredictions',
      ...common,
      scope: 'training-dataset-only-not-hidden-evaluation-v1',
      predictedClass,
    })],
    ['deep_learning_training_summary', jsonBytes({
      version: 1,
      kind: 'CanonicalCupyMlpTrainingSummary',
      ...common,
      profileHash: task.profile.deepLearningGpuProfileHash,
      gpuMemoryCapacityPlanHash: H('gpu-memory-capacity-plan'),
      seed: task.modelIr.seed,
      completedEpoch: task.modelIr.training.epochs,
      trainingStepCount:
        Math.ceil(task.trainingDataset.sampleCount / task.modelIr.training.batchSize)
          * task.modelIr.training.epochs,
      tensorBundleArtifactBytes: bundle.length,
      tensors,
      finalMetrics,
      trainingPredictionCount: task.trainingDataset.sampleCount,
      runtime: {
        framework: 'cupy',
        frameworkVersion: '13.3.0',
        cudaDriverVersion: '12.4',
        cudaRuntimeVersion: '12.4',
        gpuComputeCapability: '8.9',
        gpuDeviceSelector: GPU_SELECTOR,
        gpuModel: 'Fixture GPU',
        trainingComputeDevice: 'cuda:0-single-visible-device-v1',
      },
      networkActionPerformed: false,
      externalActionPerformed: false,
      hiddenEvaluationPerformed: false,
    })],
    ['deep_learning_training_trace', jsonBytes({
      version: 1,
      kind: 'DeepLearningTrainingMetricTrace',
      ...common,
      records: Array.from({ length: task.modelIr.training.epochs }, (_, index) => ({
        epoch: index + 1,
        accuracy,
        crossEntropy,
        gradientNorm: 0,
      })),
    })],
  ]);
}

function baseEntry(role, selectedPath, content) {
  return {
    role,
    path: selectedPath,
    hash: hashBytes(content),
    bytes: content.length,
    executionRole: 'base',
    experimentId: null,
  };
}

function archiveFixture(packageDir) {
  const bodies = semanticArchiveBodies();
  const entries = GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS
    .map((specification) => {
      const content = bodies.get(specification.role);
      const candidate = path.join(packageDir, specification.packageRelativePath);
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, content);
      return {
        taskType: specification.taskType,
        role: specification.role,
        producerRelativePath: specification.producerRelativePath,
        packageRelativePath: specification.packageRelativePath,
        sha256: hashBytes(content),
        bytes: content.length,
        sourceTaskResultHash: specification.taskType === 'pde-poisson-2d-gpu-v1'
          ? H('pde-result') : H('dl-result'),
        sourceScientificReceiptHash: specification.taskType === 'pde-poisson-2d-gpu-v1'
          ? H('pde-receipt') : H('dl-receipt'),
        sourceArtifactEvidenceHash: specification.taskType === 'pde-poisson-2d-gpu-v1'
          ? H('pde-artifacts') : H('dl-execution'),
        sourceWorkerReceiptHash: specification.taskType === 'pde-poisson-2d-gpu-v1'
          ? H('pde-worker') : H('dl-worker'),
      };
    });
  const components = (label) => ({
    runtimeClosureHash: H(`${label}:runtime-closure`),
    gpuIdentityHash: H(`${label}:gpu-identity`),
    numericRuntimePolicyHash: H(`${label}:numeric-runtime`),
    determinismPolicyHash: H(`${label}:determinism`),
    buildReproducibilityHash: H(`${label}:build-reproducibility`),
  });
  const manifest = buildGpuScientificArtifactBodyArchiveManifest({
    campaignId: 'gpu-v3-campaign',
    paperId: 'gpu-v3-paper',
    campaignPlanHash: H('campaign-plan'),
    nodeId: 'gpu-v3-campaign:0:gpu-scientific-execution',
    attemptId: 'gpu-v3-attempt',
    leaseGeneration: 3,
    gpuScientificCampaignAttemptAuthorityHash: H('attempt-authority'),
    executionPlanHash: H('execution-plan'),
    executionResultHash: H('execution-result'),
    taskSetHash: H('task-set'),
    pdeTaskHash: H('pde-task'),
    deepLearningTaskHash: H('dl-task'),
    gpuDeviceSelector: GPU_SELECTOR,
    runtimeImageDigest: H('runtime-image'),
    runtimePackageClosureHash: H('runtime-package-closure'),
    runtimeEnvironmentBomHashes: { pde: H('pde-bom'), deepLearning: H('dl-bom') },
    runtimeBomComponentHashes: { pde: components('pde'), deepLearning: components('dl') },
    originalExecutionProcessIdentityHashes: { pde: H('pde-process'), deepLearning: H('dl-process') },
    pdeTaskResultHash: H('pde-result'),
    pdeScientificReceiptHash: H('pde-receipt'),
    pdeArtifactManifestHash: H('pde-artifacts'),
    pdeWorkerReceiptHash: H('pde-worker'),
    deepLearningTaskResultHash: H('dl-result'),
    deepLearningTrainingReceiptHash: H('dl-receipt'),
    deepLearningTrainingExecutionReceiptHash: H('dl-execution'),
    deepLearningWorkerReceiptHash: H('dl-worker'),
    entries,
    createdAt: RELEASE_TIME,
  });
  const content = jsonBytes(manifest);
  const candidate = path.join(packageDir, GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH);
  fs.writeFileSync(candidate, content);
  return { manifest, manifestContent: content };
}

function authorityKey(keyId, role, subjectId, organization, pair) {
  return {
    keyId,
    status: 'active',
    algorithm: 'ed25519',
    roles: [role],
    subjectId,
    organization,
    processIdentityHash: H(`authority-process:${keyId}`),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
    revoked: false,
  };
}

function qualificationFixture(archive) {
  const request = buildGpuScientificCampaignQualificationRequest({
    campaignId: archive.campaignId,
    paperId: archive.paperId,
    campaignPlanHash: archive.campaignPlanHash,
    nodeId: archive.nodeId,
    attemptId: archive.attemptId,
    leaseGeneration: archive.leaseGeneration,
    executionPlanHash: archive.executionPlanHash,
    taskSetHash: archive.taskSetHash,
    gpuDeviceSelector: archive.gpuDeviceSelector,
    gpuScientificCampaignAttemptAuthorityHash: archive.gpuScientificCampaignAttemptAuthorityHash,
    gpuScientificCampaignExecutionResultHash: archive.executionResultHash,
    artifactArchiveManifestHash: archive.gpuScientificArtifactBodyArchiveManifestHash,
    scientificOutputCommitmentHash: archive.scientificOutputCommitmentHash,
    pdeTaskReceiptHash: archive.pdeScientificReceiptHash,
    deepLearningTaskReceiptHash: archive.deepLearningTrainingReceiptHash,
    runtimeImageDigest: archive.runtimeImageDigest,
    runtimePackageClosureHash: archive.runtimePackageClosureHash,
    originalExecutionProcessIdentityHashes: archive.originalExecutionProcessIdentityHashes,
  });
  const replayPair = crypto.generateKeyPairSync('ed25519');
  const productionPair = crypto.generateKeyPairSync('ed25519');
  const replayInput = {
    request,
    replayPdeTaskReceiptHash: H('replay-pde'),
    replayDeepLearningTaskReceiptHash: H('replay-dl'),
    replayExecutionProcessIdentityHashes: { pde: H('replay-pde-process'), deepLearning: H('replay-dl-process') },
    replayScientificOutputCommitmentHash: archive.scientificOutputCommitmentHash,
    replayedAt: '2026-08-14T00:00:00.000Z',
    signedAt: '2026-08-14T00:01:00.000Z',
    validFrom: '2026-08-14T00:01:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
  };
  const unsignedReplay = buildGpuScientificCampaignSameDeviceReplayReceipt(replayInput);
  const signedReplay = signAuthorityDocument(unsignedReplay, {
    privateKeyPem: replayPair.privateKey,
    keyId: 'gpu-replay-key',
    role: GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
  });
  const replay = buildGpuScientificCampaignSameDeviceReplayReceipt({
    ...replayInput,
    signatures: signedReplay.signatures,
  });
  const productionInput = {
    request,
    sameDeviceReplayReceipt: replay,
    signedAt: '2026-08-14T00:02:00.000Z',
    validFrom: '2026-08-14T00:02:00.000Z',
    expiresAt: '2026-08-19T00:00:00.000Z',
  };
  const unsignedProduction = buildGpuScientificCampaignProductionQualificationAuthority(productionInput);
  const signedProduction = signAuthorityDocument(unsignedProduction, {
    privateKeyPem: productionPair.privateKey,
    keyId: 'gpu-production-key',
    role: GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
  });
  const production = buildGpuScientificCampaignProductionQualificationAuthority({
    ...productionInput,
    signatures: signedProduction.signatures,
  });
  const evidence = buildGpuScientificCampaignQualificationEvidence({
    request,
    sameDeviceReplayReceipt: replay,
    productionQualificationAuthority: production,
  });
  const roots = [
    authorityKey('gpu-replay-key', GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE, 'gpu-replay-subject', 'Replay Lab', replayPair),
    authorityKey('gpu-production-key', GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE, 'gpu-production-subject', 'Qualification Lab', productionPair),
  ];
  return { evidence, roots, trustStore: { version: 1, kind: 'AuthorityTrustStore', keys: roots } };
}

function capsuleFixture(t, createdAt = RELEASE_TIME) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-gpu-capsule-v3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = archiveFixture(root);
  const qualification = qualificationFixture(archive.manifest);
  const qualificationContent = jsonBytes(qualification.evidence);
  fs.writeFileSync(path.join(root, CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_PATH), qualificationContent);
  const trustSnapshot = buildPublicAuthorityTrustSnapshot({
    trustStore: qualification.trustStore,
    referencedKeyIds: ['gpu-replay-key', 'gpu-production-key'],
    capturedAt: createdAt,
  });
  const authoritySummary = {
    version: 1,
    kind: 'CampaignReleaseGpuScientificQualificationAuthoritySummary',
    qualificationEvidenceHash: qualification.evidence.gpuScientificCampaignQualificationEvidenceHash,
    replayAuthorityKeyId: 'gpu-replay-key',
    replayAuthorityRole: GPU_SCIENTIFIC_SAME_DEVICE_REPLAY_AUTHORITY_ROLE,
    productionQualificationAuthorityKeyId: 'gpu-production-key',
    productionQualificationAuthorityRole: GPU_SCIENTIFIC_PRODUCTION_QUALIFICATION_AUTHORITY_ROLE,
    packageInternalSignatureVerificationRequired: true,
    externalTrustAnchorRequired: true,
  };
  const baseRoles = [
    ['portable_research_report', 'evidence/RESEARCH_REPORT.json'],
    ['portable_experiment_registry', 'evidence/EXPERIMENT_REGISTRY.json'],
    ['research_environment_manifest', 'evidence/ENVIRONMENT_MANIFEST.json'],
    ['research_public_authority_evidence', 'evidence/PUBLIC_AUTHORITY_EVIDENCE.json'],
    ['public_authority_trust_snapshot', 'evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json'],
  ];
  const baseEntries = baseRoles.map(([role, selectedPath]) => {
    const content = role === 'public_authority_trust_snapshot'
      ? jsonBytes(trustSnapshot) : jsonBytes({ role });
    if (role === 'public_authority_trust_snapshot') {
      fs.mkdirSync(path.dirname(path.join(root, selectedPath)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, selectedPath), content);
    }
    return baseEntry(role, selectedPath, content);
  });
  const gpuEntries = [
    baseEntry(CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_ROLE, CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_PATH, qualificationContent),
    baseEntry(CAMPAIGN_RELEASE_GPU_SCIENTIFIC_ARCHIVE_MANIFEST_ROLE, GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH, archive.manifestContent),
    ...archive.manifest.entries.map((entry) => ({
      role: entry.role,
      path: entry.packageRelativePath,
      hash: entry.sha256,
      bytes: entry.bytes,
      executionRole: 'base',
      experimentId: null,
    })),
  ];
  const manifest = buildCampaignReleaseEvidenceCapsuleManifest({
    campaignId: archive.manifest.campaignId,
    paperId: archive.manifest.paperId,
    researchReportHash: H('research-report'),
    experimentRegistryHash: H('registry'),
    verifiedSourceMerkleHash: H('source-merkle'),
    verifiedSourceWorkspaceManifestHash: H('source-manifest'),
    researchVerifyNodeId: 'gpu-v3-campaign:research-verify',
    researchVerifyAttemptId: 'research-attempt',
    researchVerifyLeaseGeneration: 1,
    publicAuthorityTrustSnapshotHash: trustSnapshot.publicAuthorityTrustSnapshotHash,
    entries: [...baseEntries, ...gpuEntries],
    gpuScientificArtifactBodyArchiveManifest: archive.manifest,
    gpuScientificQualificationEvidence: qualification.evidence,
    createdAt,
  });
  const documents = new Map([
    [CAMPAIGN_RELEASE_GPU_SCIENTIFIC_QUALIFICATION_EVIDENCE_PATH, qualification.evidence],
    [GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH, archive.manifest],
    ['evidence/PUBLIC_AUTHORITY_EVIDENCE.json', {
      sourceAuthenticityRequiresExternalTrustAnchor: true,
      gpuScientificQualificationAuthority: authoritySummary,
    }],
  ]);
  return { root, archive, qualification, trustSnapshot, manifest, documents };
}

function productionReleasePackager(t, { trustStore, now }) {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-gpu-authority-freshness-',
  ));
  const workspace = path.join(root, 'workspace');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, 'trust'), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json'),
    jsonBytes(trustStore),
  );
  const store = createDefaultPaperStore({ root: workspace, runtimeRoot });
  convergeAutonomousSubmissionHandoff({ nativeStore: store, runtimeRoot });
  const clock = Object.freeze({
    version: 1,
    kind: 'GpuAuthorityFreshnessTestClock',
    now: () => new Date(now),
    nowIso: () => new Date(now).toISOString(),
  });
  const context = bootstrapAutomationContext({
    root: workspace,
    runtimeRoot,
    mode: 'gpu-authority-freshness-test',
    serviceOverrides: { store, clock },
  });
  t.after(() => {
    context.services.persistenceSession.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { releasePackager: context.services.releasePackager, runtimeRoot };
}

function freshnessPackageInput(qualificationEvidence, runtimeRoot, createdAt) {
  const finalCompileNode = {
    nodeId: 'gpu-freshness:final-compile',
    kind: 'final-compile',
    status: 'completed',
  };
  const researchVerifyNode = {
    nodeId: 'gpu-freshness:research-verify',
    kind: 'research-verify',
    status: 'completed',
    attemptId: 'gpu-freshness-research-attempt',
    leaseGeneration: 1,
    dependencies: [finalCompileNode.nodeId],
  };
  return {
    campaign: {
      campaignId: 'gpu-freshness',
      paperId: 'gpu-freshness-paper',
      spec: { campaignPlanHash: H('gpu-freshness-plan') },
    },
    packageNode: {
      nodeId: 'gpu-freshness:package',
      kind: 'package',
      dependencies: [researchVerifyNode.nodeId],
    },
    finalCompileNode,
    researchVerifyNode,
    researchReport: {
      kind: 'PaperResearchVerifyReport',
      researchReportHash: H('gpu-freshness-research-report'),
      promotionEligibility: { status: 'research_promotion_ready' },
    },
    gpuScientificExecutionPlan: {
      gpuScientificCampaignExecutionPlanHash: H('gpu-freshness-execution-plan'),
    },
    gpuScientificResearchEvidence: {
      qualificationEvidenceHash:
        qualificationEvidence.gpuScientificCampaignQualificationEvidenceHash,
      qualificationEvidence,
    },
    sourceWorkspace: runtimeRoot,
    runtimeRoot,
    createdAt,
  };
}

test('GPU capsule v3 binds the exact semantic-replay body set, qualification, and signed manifest', (t) => {
  const value = capsuleFixture(t);
  assert.equal(value.manifest.version, 3);
  assert.equal(value.manifest.gpuScientificEvidence.archiveBodyCount, 11);
  assert.equal(verifyCampaignReleaseEvidenceCapsuleManifest(value.manifest, {
    gpuScientificEvidenceRequired: true,
  }).valid, true);
  const offline = verifyCampaignReleaseGpuScientificCapsuleDirectorySync({
    packageDir: value.root,
    manifest: value.manifest,
    documents: value.documents,
    publicAuthorityTrustSnapshot: value.trustSnapshot,
    trustedAuthorityRoots: value.qualification.roots,
    verificationTime: value.manifest.createdAt,
  });
  assert.equal(offline.valid, true, JSON.stringify(offline.blockers));
  assert.equal(offline.qualificationAuthorityInspection.cryptographicSignaturesVerified, true);
  assert.equal(offline.externalAuthorityTrustVerification.externalTrustAnchorVerified, true);

  const missingProcessIdentity = structuredClone(value.qualification.trustStore);
  delete missingProcessIdentity.keys[0].processIdentityHash;
  assert.throws(() => buildPublicAuthorityTrustSnapshot({
    trustStore: missingProcessIdentity,
    referencedKeyIds: ['gpu-replay-key', 'gpu-production-key'],
    capturedAt: RELEASE_TIME,
  }), /public_authority_trust_snapshot_invalid/);
  const processIdentityDrift = structuredClone(value.qualification.roots);
  processIdentityDrift[0].processIdentityHash = H('external-process-drift');
  const driftedExternalRoot =
    verifyCampaignReleaseGpuScientificCapsuleDirectorySync({
      packageDir: value.root,
      manifest: value.manifest,
      documents: value.documents,
      publicAuthorityTrustSnapshot: value.trustSnapshot,
      trustedAuthorityRoots: processIdentityDrift,
      verificationTime: value.manifest.createdAt,
    });
  assert.equal(driftedExternalRoot.valid, false);
  assert.ok(driftedExternalRoot.blockers.some((blocker) => (
    blocker.includes('offline_authority_external_trust_anchor_mismatch')
  )));

  const releasePair = crypto.generateKeyPairSync('ed25519');
  const manifestContent = jsonBytes(value.manifest);
  const unsigned = buildCampaignReleaseExecutionAttestationUnsignedPayload({
    manifest: value.manifest,
    manifestFileHash: hashBytes(manifestContent),
    signer: { keyId: 'release-key', keyVersion: 'v1', subjectId: 'release-subject', organization: 'Release Office' },
    signedAt: RELEASE_TIME,
    expiresAt: '2026-08-18T00:00:00.000Z',
  });
  const attestation = finalizeCampaignReleaseExecutionAttestation({
    unsignedPayload: unsigned,
    signature: crypto.sign(null, Buffer.from(campaignReleaseExecutionAttestationSigningPayloadHash(unsigned)), releasePair.privateKey).toString('base64'),
  });
  assert.equal(verifyCampaignReleaseExecutionAttestationStructure(attestation, {
    manifest: value.manifest,
    researchEvidenceCapsuleManifestHash: value.manifest.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash: hashBytes(manifestContent),
  }).valid, true);
  const attestationContent = jsonBytes(attestation);
  const capsuleFiles = value.manifest.entries.map((entry) => ({
    role: 'research_evidence_capsule_file', capsuleRole: entry.role,
    executionRole: entry.executionRole, experimentId: entry.experimentId,
    path: `/package/${entry.path}`, packageRelativePath: entry.path,
    hash: entry.hash, bytes: entry.bytes,
  }));
  const packageOutput = {
    researchEvidenceCapsuleManifestHash: value.manifest.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash: hashBytes(manifestContent),
    researchExecutionReleaseAttestationHash: attestation.campaignReleaseExecutionAttestationHash,
    researchExecutionReleaseAttestationFileHash: campaignReleaseExecutionAttestationDocumentFileHash(attestation),
    files: [
      ...capsuleFiles,
      { role: 'research_evidence_capsule_manifest', capsuleRole: 'research_evidence_capsule_manifest', path: '/package/evidence/CAPSULE_MANIFEST.json', packageRelativePath: 'evidence/CAPSULE_MANIFEST.json', hash: hashBytes(manifestContent), bytes: manifestContent.length },
      { role: 'research_execution_release_attestation', capsuleRole: 'research_execution_release_attestation', path: '/package/evidence/CAPSULE_MANIFEST.external-attestation.json', packageRelativePath: 'evidence/CAPSULE_MANIFEST.external-attestation.json', hash: hashBytes(attestationContent), bytes: attestationContent.length },
    ],
  };
  assert.equal(verifyCampaignReleaseEvidenceCapsulePackageOutput({
    packageOutput, manifest: value.manifest, executionAttestation: attestation,
  }), true);
  const required = ['compiled_pdf', 'generated_source_zip', 'package_record', 'sha256sums', 'independent_rebuilt_pdf', 'independent_pdf_rebuild_receipt']
    .map((role, index) => ({ role, path: `/package/${role}-${index}`, hash: H(role), bytes: 1 }));
  const policyOutput = { ...packageOutput, files: [...required, ...packageOutput.files] };
  policyOutput.fileCount = policyOutput.files.length;
  assert.equal(campaignReleasePackageOutputFilesValid(policyOutput), true);
  const roleDrift = structuredClone(policyOutput);
  roleDrift.files.find((file) => file.capsuleRole === value.archive.manifest.entries[0].role).capsuleRole = 'gpu_body_role_drift';
  assert.equal(campaignReleasePackageOutputFilesValid(roleDrift), false);
});

test('GPU capsule offline verification rejects body tampering and authority expiry at package time', (t) => {
  const value = capsuleFixture(t);
  const bodyPath = value.archive.manifest.entries[0].packageRelativePath;
  fs.appendFileSync(path.join(value.root, bodyPath), 'tampered');
  const tampered = verifyCampaignReleaseGpuScientificCapsuleDirectorySync({
    packageDir: value.root,
    manifest: value.manifest,
    documents: value.documents,
    publicAuthorityTrustSnapshot: value.trustSnapshot,
    trustedAuthorityRoots: value.qualification.roots,
  });
  assert.equal(tampered.valid, false);
  assert.ok(tampered.blockers.some((blocker) => blocker.includes('body_invalid')));

  const expired = capsuleFixture(t, EXPIRED_RELEASE_TIME);
  const expiredVerification = verifyCampaignReleaseGpuScientificCapsuleDirectorySync({
    packageDir: expired.root,
    manifest: expired.manifest,
    documents: expired.documents,
    publicAuthorityTrustSnapshot: expired.trustSnapshot,
    trustedAuthorityRoots: expired.qualification.roots,
    verificationTime: expired.manifest.createdAt,
  });
  assert.equal(expiredVerification.valid, false);
  assert.ok(expiredVerification.blockers.some((blocker) => blocker.includes('authority_expired')));
});

test('release freshness receipt uses one frozen provider snapshot and rechecks the packaged snapshot at the current clock', (t) => {
  const value = capsuleFixture(t);
  let providerReads = 0;
  let providerValue = value.qualification.trustStore;
  const frozenTrustStore =
    freezeCampaignReleaseGpuScientificAuthorityTrustStore({
      trustStoreProvider: () => {
        providerReads += 1;
        return providerValue;
      },
      runtimeRoot: value.root,
    });
  const verifier = createGpuScientificCampaignPromotionAuthorityVerifier({
    trustStoreProvider: () => {
      throw new Error('dynamic_provider_read_after_freeze');
    },
    clock: { now: () => new Date(RELEASE_TIME) },
  });
  const initialAuthorityInspection = verifier.verify({
    qualificationEvidence: value.qualification.evidence,
    trustStore: frozenTrustStore,
    observedAt: RELEASE_TIME,
  });
  assert.equal(initialAuthorityInspection.valid, true);
  const revokedAfterFreeze = structuredClone(value.qualification.trustStore);
  revokedAfterFreeze.keys[0].status = 'revoked';
  revokedAfterFreeze.keys[0].revoked = true;
  providerValue = revokedAfterFreeze;
  const manifestFileHash = hashBytes(jsonBytes(value.manifest));
  const attestationHash = H('freshness-test-release-attestation');
  const packageResult = {
    packageDirAbsolute: value.root,
    researchEvidenceCapsule: {
      manifest: value.manifest,
      manifestFile: { hash: manifestFileHash },
      researchExecutionReleaseAttestationHash: attestationHash,
    },
  };
  const receipt = verifyPackagedGpuScientificAuthorityFreshness({
    packageResult,
    qualificationEvidence: value.qualification.evidence,
    initialAuthorityInspection,
    initialObservedAt: RELEASE_TIME,
    frozenAuthorityTrustStore: frozenTrustStore,
    gpuScientificPromotionAuthorityVerifier: verifier,
    clock: { now: () => new Date(RELEASE_TIME) },
  });
  assert.equal(providerReads, 1);
  assert.equal(receipt.publicAuthorityTrustSnapshotHash,
    value.trustSnapshot.publicAuthorityTrustSnapshotHash);
  assert.equal(verifyGpuScientificReleaseAuthorityFreshnessReceipt(receipt, {
    qualificationEvidence: value.qualification.evidence,
    researchEvidenceCapsuleManifest: value.manifest,
    researchEvidenceCapsuleManifestFileHash: manifestFileHash,
    researchExecutionReleaseAttestationHash: attestationHash,
    authorityInspectionVerifier: (input) => verifier.verify(input),
  }).valid, true);

  const externalRootVerifier =
    createGpuScientificCampaignPromotionAuthorityVerifier({
      trustStoreProvider: () => ({
        version: 1,
        kind: 'AuthorityTrustStore',
        keys: [],
      }),
      clock: { now: () => new Date(RELEASE_TIME) },
    });
  const alternateRootVerification =
    verifyGpuScientificReleaseAuthorityFreshnessReceipt(receipt, {
      qualificationEvidence: value.qualification.evidence,
      researchEvidenceCapsuleManifest: value.manifest,
      researchEvidenceCapsuleManifestFileHash: manifestFileHash,
      researchExecutionReleaseAttestationHash: attestationHash,
      authorityInspectionVerifier: (input) => (
        externalRootVerifier.verifyReleaseSnapshot(input)
      ),
      verificationTime: RELEASE_TIME,
    });
  assert.equal(alternateRootVerification.valid, false);
  assert.ok(alternateRootVerification.blockers.includes(
    'gpu_scientific_release_authority_freshness_cryptographic_verification_invalid',
  ));

  assert.throws(() => verifyPackagedGpuScientificAuthorityFreshness({
    packageResult,
    qualificationEvidence: value.qualification.evidence,
    initialAuthorityInspection,
    initialObservedAt: RELEASE_TIME,
    frozenAuthorityTrustStore: frozenTrustStore,
    gpuScientificPromotionAuthorityVerifier: verifier,
    clock: { now: () => new Date(EXPIRED_RELEASE_TIME) },
  }), /campaign_release_gpu_scientific_authority_freshness_blocked:.*authority_expired/);
});

test('freshness receipt rejects a self-hashed zero-signature inspection and package-carried rogue public keys', (t) => {
  const value = capsuleFixture(t);
  const verifier = createGpuScientificCampaignPromotionAuthorityVerifier({
    trustStoreProvider: () => value.qualification.trustStore,
    clock: { now: () => new Date(RELEASE_TIME) },
  });
  const validInspection = verifier.verify({
    qualificationEvidence: value.qualification.evidence,
    observedAt: RELEASE_TIME,
  });
  const manifestFileHash = hashBytes(jsonBytes(value.manifest));
  const attestationHash = H('forged-freshness-release-attestation');
  const receipt = verifyPackagedGpuScientificAuthorityFreshness({
    packageResult: {
      packageDirAbsolute: value.root,
      researchEvidenceCapsule: {
        manifest: value.manifest,
        manifestFile: { hash: manifestFileHash },
        researchExecutionReleaseAttestationHash: attestationHash,
      },
    },
    qualificationEvidence: value.qualification.evidence,
    initialAuthorityInspection: validInspection,
    initialObservedAt: RELEASE_TIME,
    frozenAuthorityTrustStore: value.qualification.trustStore,
    gpuScientificPromotionAuthorityVerifier: verifier,
    clock: { now: () => new Date(RELEASE_TIME) },
  });

  const forgedQualification = structuredClone(value.qualification.evidence);
  forgedQualification.gpuScientificCampaignSameDeviceReplayReceipt.signatures = [];
  forgedQualification
    .gpuScientificCampaignProductionQualificationAuthority.signatures = [];
  const {
    gpuScientificCampaignQualificationEvidenceHash: ignoredQualificationHash,
    ...forgedQualificationPayload
  } = forgedQualification;
  forgedQualification.gpuScientificCampaignQualificationEvidenceHash =
    hashRecord(
      'GpuScientificCampaignQualificationEvidence',
      forgedQualificationPayload,
    );
  const forgedInspectionPayload = {
    ...validInspection,
    qualificationEvidenceHash:
      forgedQualification.gpuScientificCampaignQualificationEvidenceHash,
  };
  delete forgedInspectionPayload
    .gpuScientificCampaignQualificationAuthorityInspectionHash;
  const forgedInspection = {
    ...forgedInspectionPayload,
    gpuScientificCampaignQualificationAuthorityInspectionHash: hashRecord(
      'GpuScientificCampaignQualificationAuthorityInspection',
      forgedInspectionPayload,
    ),
  };
  const rogueTrustStore = structuredClone(value.qualification.trustStore);
  for (const key of rogueTrustStore.keys) {
    const roguePair = crypto.generateKeyPairSync('ed25519');
    key.publicKeyPem = roguePair.publicKey.export({
      type: 'spki',
      format: 'pem',
    });
  }
  const rogueSnapshot = buildPublicAuthorityTrustSnapshot({
    trustStore: rogueTrustStore,
    referencedKeyIds: rogueTrustStore.keys.map((key) => key.keyId),
    capturedAt: value.manifest.createdAt,
  });
  const forgedManifest = structuredClone(value.manifest);
  forgedManifest.publicAuthorityTrustSnapshotHash =
    rogueSnapshot.publicAuthorityTrustSnapshotHash;
  const rogueSnapshotBytes = jsonBytes(rogueSnapshot);
  const snapshotEntry = forgedManifest.entries.find(
    (entry) => entry.role === 'public_authority_trust_snapshot',
  );
  snapshotEntry.hash = hashBytes(rogueSnapshotBytes);
  snapshotEntry.bytes = rogueSnapshotBytes.length;
  const {
    researchEvidenceCapsuleManifestHash: ignoredManifestHash,
    ...forgedManifestPayload
  } = forgedManifest;
  forgedManifest.researchEvidenceCapsuleManifestHash = hashRecord(
    'CampaignReleaseResearchEvidenceCapsuleManifest',
    forgedManifestPayload,
  );
  const forgedReceipt = structuredClone(receipt);
  forgedReceipt.gpuScientificCampaignQualificationEvidenceHash =
    forgedQualification.gpuScientificCampaignQualificationEvidenceHash;
  forgedReceipt.initialAuthorityInspection = forgedInspection;
  forgedReceipt.initialAuthorityInspectionHash = forgedInspection
    .gpuScientificCampaignQualificationAuthorityInspectionHash;
  forgedReceipt.freshAuthorityInspection = forgedInspection;
  forgedReceipt.freshAuthorityInspectionHash = forgedInspection
    .gpuScientificCampaignQualificationAuthorityInspectionHash;
  forgedReceipt.publicAuthorityTrustSnapshot = rogueSnapshot;
  forgedReceipt.publicAuthorityTrustSnapshotHash =
    rogueSnapshot.publicAuthorityTrustSnapshotHash;
  forgedReceipt.researchEvidenceCapsuleManifestHash =
    forgedManifest.researchEvidenceCapsuleManifestHash;
  forgedReceipt.researchEvidenceCapsuleManifestFileHash =
    hashBytes(jsonBytes(forgedManifest));
  const {
    gpuScientificReleaseAuthorityFreshnessReceiptHash: ignoredReceiptHash,
    ...forgedReceiptPayload
  } = forgedReceipt;
  forgedReceipt.gpuScientificReleaseAuthorityFreshnessReceiptHash = hashRecord(
    'GpuScientificReleaseAuthorityFreshnessReceipt',
    forgedReceiptPayload,
  );

  const verification = verifyGpuScientificReleaseAuthorityFreshnessReceipt(
    forgedReceipt,
    {
      qualificationEvidence: forgedQualification,
      researchEvidenceCapsuleManifest: forgedManifest,
      researchEvidenceCapsuleManifestFileHash:
        forgedReceipt.researchEvidenceCapsuleManifestFileHash,
      researchExecutionReleaseAttestationHash: attestationHash,
      authorityInspectionVerifier: (input) => (
        verifier.verifyReleaseSnapshot(input)
      ),
      verificationTime: RELEASE_TIME,
    },
  );
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes(
    'gpu_scientific_release_authority_freshness_cryptographic_verification_invalid',
  ));
});

test('production release packager rejects authority revoked after research verification', async (t) => {
  const value = capsuleFixture(t);
  const researchInspection =
    verifyGpuScientificCampaignQualificationEvidenceAuthority({
      qualificationEvidence: value.qualification.evidence,
      trustStore: value.qualification.trustStore,
      now: new Date(RELEASE_TIME),
    });
  assert.equal(researchInspection.valid, true);

  const revokedTrustStore = structuredClone(value.qualification.trustStore);
  revokedTrustStore.keys[0].status = 'revoked';
  revokedTrustStore.keys[0].revoked = true;
  revokedTrustStore.keys[0].revokedAt = '2026-08-16T00:00:00.000Z';
  const production = productionReleasePackager(t, {
    trustStore: revokedTrustStore,
    now: REVOKED_RELEASE_TIME,
  });
  await assert.rejects(
    production.releasePackager.packageRelease(freshnessPackageInput(
      value.qualification.evidence,
      production.runtimeRoot,
      RELEASE_TIME,
    )),
    (error) => {
      assert.equal(
        error.code,
        'campaign_release_gpu_scientific_authority_freshness_blocked',
      );
      assert.match(error.message, /signature_key_not_active/);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('production release packager rejects authority expired after research verification', async (t) => {
  const value = capsuleFixture(t);
  const researchInspection =
    verifyGpuScientificCampaignQualificationEvidenceAuthority({
      qualificationEvidence: value.qualification.evidence,
      trustStore: value.qualification.trustStore,
      now: new Date(RELEASE_TIME),
    });
  assert.equal(researchInspection.valid, true);

  const production = productionReleasePackager(t, {
    trustStore: value.qualification.trustStore,
    now: EXPIRED_RELEASE_TIME,
  });
  await assert.rejects(
    production.releasePackager.packageRelease(freshnessPackageInput(
      value.qualification.evidence,
      production.runtimeRoot,
      RELEASE_TIME,
    )),
    (error) => {
      assert.equal(
        error.code,
        'campaign_release_gpu_scientific_authority_freshness_blocked',
      );
      assert.match(error.message, /authority_expired/);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('release freshness gate accepts a current independently signed authority inspection', async (t) => {
  const value = capsuleFixture(t);
  const clock = { now: () => new Date(RELEASE_TIME) };
  const verifier = createGpuScientificCampaignPromotionAuthorityVerifier({
    trustStoreProvider: () => value.qualification.trustStore,
    clock,
  });
  const releasePackager = createCampaignReleasePackager({
    artifactRepositoryFactory: () => ({}),
    runtimeRoot: value.root,
    operatorDatasetAuthorityTrustStoreProvider:
      () => value.qualification.trustStore,
    clock,
    gpuScientificPromotionAuthorityVerifier: verifier,
    packageAdapter: async () => {
      throw new Error('gpu_freshness_test_package_adapter_unexpected');
    },
  });
  await assert.rejects(
    releasePackager.packageRelease(freshnessPackageInput(
      value.qualification.evidence,
      value.root,
      RELEASE_TIME,
    )),
    (error) => {
      assert.match(error.message, /campaign_release_research_source_snapshot_invalid/);
      assert.doesNotMatch(error.message, /gpu_scientific_authority_freshness/);
      return true;
    },
  );
});

test('capsule builder remains byte-equivalent v2 when GPU evidence is absent', () => {
  const entries = [
    ['portable_research_report', 'evidence/RESEARCH_REPORT.json'],
    ['portable_experiment_registry', 'evidence/EXPERIMENT_REGISTRY.json'],
    ['research_environment_manifest', 'evidence/ENVIRONMENT_MANIFEST.json'],
    ['research_public_authority_evidence', 'evidence/PUBLIC_AUTHORITY_EVIDENCE.json'],
    ['public_authority_trust_snapshot', 'evidence/PUBLIC_AUTHORITY_TRUST_SNAPSHOT.json'],
  ].map(([role, selectedPath]) => baseEntry(role, selectedPath, jsonBytes({ role })));
  const input = {
    campaignId: 'v2-campaign', paperId: 'v2-paper', researchReportHash: H('v2-report'),
    experimentRegistryHash: H('v2-registry'), verifiedSourceMerkleHash: H('v2-merkle'),
    verifiedSourceWorkspaceManifestHash: H('v2-workspace'), researchVerifyNodeId: 'v2:research',
    researchVerifyAttemptId: 'v2-attempt', researchVerifyLeaseGeneration: 1,
    publicAuthorityTrustSnapshotHash: H('v2-trust'), entries, createdAt: RELEASE_TIME,
  };
  const omitted = buildCampaignReleaseEvidenceCapsuleManifest(input);
  const explicitNull = buildCampaignReleaseEvidenceCapsuleManifest({
    ...input,
    gpuScientificArtifactBodyArchiveManifest: null,
    gpuScientificQualificationEvidence: null,
  });
  assert.equal(omitted.version, 2);
  assert.equal(JSON.stringify(omitted), JSON.stringify(explicitNull));
  assert.equal(Object.hasOwn(omitted, 'gpuScientificEvidenceIncluded'), false);
});
