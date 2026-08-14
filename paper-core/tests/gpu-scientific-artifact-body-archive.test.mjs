import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS,
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH,
  buildGpuScientificArtifactBodyArchiveManifest,
  verifyGpuScientificArtifactBodyArchiveManifest,
} from '../../paper-domain/automation/gpu-scientific-artifact-body-archive-contract.mjs';
import {
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  buildCanonicalGpuScientificCampaignExecutionPlan,
  buildGpuScientificCampaignAttemptAuthority,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  buildEmpiricalEnvironmentBom,
} from '../../paper-domain/automation/environment-bom-contract.mjs';
import {
  inspectGpuScientificArtifactBodyArchiveSourceSync,
  materializeGpuScientificArtifactBodyArchiveSync,
  verifyOfflineGpuScientificArtifactBodyArchiveDirectorySync,
} from '../../paper-adapters/build-package/gpu-scientific-artifact-body-archive.mjs';
import {
  installGpuScientificArtifactBodyArchiveFileSync,
  rollbackGpuScientificArtifactBodyArchiveFilesSync,
} from '../../paper-adapters/build-package/gpu-scientific-artifact-body-archive-file-repository.mjs';
import { safeRetentionNodeKey } from '../../paper-adapters/automation/runtime-retention-scope-repository.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const CAMPAIGN_ID = 'gpu-body-archive-campaign';
const PAPER_ID = 'gpu-body-archive-paper';
const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';
const CREATED_AT = '2026-08-14T04:00:00.000Z';
const H = (label) => hashRecord('GpuScientificArtifactBodyArchiveTest', { label });

function record(kind, hashField, payload) {
  return {
    ...payload,
    [hashField]: hashRecord(kind, payload),
  };
}

function environmentBom(label) {
  const runtimeImageDigest = H('python-gpu-runtime-image');
  return buildEmpiricalEnvironmentBom({
    platform: {
      operatingSystem: 'linux',
      architecture: 'x64',
      kernelReleaseHash: H('kernel-release'),
      cpu: {
        modelHash: H('cpu-model'),
        flagsHash: H('cpu-flags'),
        logicalProcessorCount: 8,
        observation: 'fixture',
      },
    },
    runtime: {
      type: 'container',
      identityHash: runtimeImageDigest,
      language: 'python',
      languageVersionHash: H('python-version'),
      containerImageDigest: runtimeImageDigest,
      packageClosure: {
        basis: 'container_image_digest',
        identityHash: runtimeImageDigest,
        manifestHash: null,
        observedPackageCount: 0,
      },
    },
    gpu: {
      required: true,
      status: 'observed',
      deviceCount: 1,
      modelSetHash: H('gpu-model'),
      computeCapabilitySetHash: H('gpu-compute-capability'),
      driverVersionHash: H('gpu-driver'),
      runtimeVersionHash: H('gpu-runtime'),
    },
    numericRuntime: {
      threads: {},
      dynamicThreadingDisabled: false,
      explicitSingleThreadPolicy: false,
      policyObservation: 'fixture',
    },
    limits: {
      timeoutMs: label === 'pde' ? 900_000 : 3_600_000,
      memoryBytes: label === 'pde' ? 2 * 1024 ** 3 : 8 * 1024 ** 3,
      cpuSeconds: label === 'pde' ? 900 : 3_600,
      maximumPids: label === 'pde' ? 16 : 32,
      maximumOutputBytes: label === 'pde' ? 8 * 1024 ** 2 : 2 * 1024 ** 3,
      maximumCapturedBytes: 4 * 1024 * 1024,
    },
    determinism: { classification: 'gpu_nondeterministic' },
    buildReproducibility: { status: 'not_assessed' },
    observedClaims: [`fixture-${label}-runtime`],
    unobservedClaims: ['bitwise-runtime-rebuild'],
  });
}

function workerReceipt(artifacts, label) {
  const bom = environmentBom(label);
  const executionProcessIdentity = {
    version: 1,
    kind: 'OsSandboxWorkerProcessIdentity',
    processInvocationId: H(`${label}:process-invocation`),
    launcherPid: label === 'pde' ? 41001 : 41002,
  };
  const payload = {
    version: 5,
    kind: 'OsSandboxWorkerReceipt',
    status: 'os_sandbox_worker_passed',
    evidenceClass: 'production-runtime-observation-v1',
    productionEvidenceEligible: true,
    artifactManifestHash: hashRecord('OsSandboxWorkerArtifactManifest', artifacts),
    artifacts,
    containerImageDigest: bom.runtime.containerImageDigest,
    environmentBom: bom,
    environmentBomHash: bom.environmentBomHash,
    executionProcessIdentity,
    executionProcessIdentityHash: hashRecord(
      'OsSandboxWorkerProcessIdentity',
      executionProcessIdentity,
    ),
    gpuDeviceRequest: { deviceSelector: GPU_UUID },
    externalActionPerformed: false,
    fixtureBindingHash: H(`worker:${label}`),
  };
  return {
    ...payload,
    ok: true,
    receiptHash: hashRecord('OsSandboxWorkerReceipt', payload),
    blockers: [],
  };
}

function jsonBody(label) {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    kind: 'GpuScientificArtifactBodyArchiveTestBody',
    label,
  })}\n`, 'utf8');
}

function bodyContent() {
  return new Map([
    ['solutions/n31.f64le', Buffer.alloc(31 * 31 * 8, 0x31)],
    ['solutions/n63.f64le', Buffer.alloc(63 * 63 * 8, 0x63)],
    ['solutions/n127.f64le', Buffer.alloc(127 * 127 * 8, 0x7f)],
    ['producer-diagnostics.json', jsonBody('pde-producer-diagnostics')],
    ['model-spec.json', jsonBody('deep-learning-model-specification')],
    ['tensor-bundle.bin', Buffer.from('deterministic-cupy-tensor-bundle-v1')],
    ['training-predictions.json', jsonBody('deep-learning-training-predictions')],
    ['training-summary.json', jsonBody('deep-learning-training-summary')],
    ['training-trace.json', jsonBody('deep-learning-training-trace')],
  ]);
}

function artifact(content, selectedPath) {
  const bytes = content.get(selectedPath);
  return { path: selectedPath, sha256: hashBytes(bytes), bytes: bytes.length };
}

function createFixture(t, { pdeOutputDirectoryOverride = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-gpu-body-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const packageDir = path.join(runtimeRoot, 'packages', 'package-attempt');
  fs.mkdirSync(packageDir, { recursive: true, mode: 0o700 });
  const executionPlan = buildCanonicalGpuScientificCampaignExecutionPlan({
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    gpuDeviceSelector: GPU_UUID,
    absoluteExecutionDeadlineEpochMs: 2_000_000_000_000,
  });
  const campaign = {
    campaignId: CAMPAIGN_ID,
    paperId: PAPER_ID,
    spec: {
      campaignPlanHash: H('campaign-plan'),
      gpuScientificExecutionPlan: executionPlan,
    },
  };
  const node = {
    nodeId: executionPlan.nodeId,
    kind: 'gpu-scientific-execution',
    attemptId: 'gpu-body-archive-attempt-1',
    leaseGeneration: 3,
    gpuScientificExecutionPlanHash:
      executionPlan.gpuScientificCampaignExecutionPlanHash,
    gpuScientificResourceBudgetHash:
      GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash,
  };
  const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
    campaign,
    node,
    plan: executionPlan,
  });
  const requestHash = H('pde-request');
  const attemptRoot = path.join(
    runtimeRoot,
    'automation-artifacts',
    safeRetentionNodeKey(CAMPAIGN_ID),
    `gpu-scientific-attempt-${attemptAuthority
      .gpuScientificCampaignAttemptAuthorityHash.slice('sha256:'.length)}`,
  );
  const pdeRoot = path.join(
    attemptRoot,
    'pde-poisson-2d',
    `pde-${requestHash.slice('sha256:'.length)}`,
  );
  const deepLearningRoot = path.join(
    attemptRoot,
    'deep-learning-cupy-mlp',
    `training-${hashRecord('DeepLearningTrainingRunDirectory', {
      trainingRunId: executionPlan.tasks[1].trainingRunId,
    }).slice('sha256:'.length)}`,
  );
  const content = bodyContent();
  for (const specification of GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS) {
    const outputRoot = specification.taskType === 'pde-poisson-2d-gpu-v1'
      ? pdeRoot : deepLearningRoot;
    const candidate = path.join(
      outputRoot,
      ...specification.producerRelativePath.split('/'),
    );
    fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
    fs.writeFileSync(candidate, content.get(specification.producerRelativePath), {
      mode: 0o600,
    });
  }
  const pdeArtifactPaths = [
    'solutions/n31.f64le', 'solutions/n63.f64le', 'solutions/n127.f64le',
    'producer-diagnostics.json',
  ];
  const pdeWorkerArtifacts = pdeArtifactPaths.map(
    (selectedPath) => artifact(content, selectedPath),
  );
  const pdeWorkerReceipt = workerReceipt(pdeWorkerArtifacts, 'pde');
  const pdeManifestPayload = {
    version: 3,
    kind: 'PdePoisson2dGpuArtifactManifest',
    requestHash,
    workerReceiptHash: pdeWorkerReceipt.receiptHash,
    producerDiagnosticsHash:
      artifact(content, 'producer-diagnostics.json').sha256,
    osSandboxWorkerReceipt: pdeWorkerReceipt,
    artifacts: [31, 63, 127].map((gridSize) => {
      const selectedPath = `solutions/n${gridSize}.f64le`;
      return {
        gridSize,
        relativePath: selectedPath,
        sha256: artifact(content, selectedPath).sha256,
        bytes: artifact(content, selectedPath).bytes,
      };
    }),
  };
  const pdeArtifactManifest = record(
    'PdePoisson2dGpuArtifactManifest',
    'pdePoisson2dGpuArtifactManifestHash',
    pdeManifestPayload,
  );
  const pdeGpuReceipt = record(
    'CanonicalCupyPdePoisson2dExecutionReceipt',
    'canonicalCupyPdePoisson2dExecutionReceiptHash',
    {
      version: 1,
      kind: 'CanonicalCupyPdePoisson2dExecutionReceipt',
      status: 'canonical_cupy_pde_poisson_2d_executed_pending_cpu_oracle',
      requestHash,
      outputDirectory: pdeOutputDirectoryOverride || pdeRoot,
      artifactManifest: pdeArtifactManifest,
      artifactManifestHash:
        pdeArtifactManifest.pdePoisson2dGpuArtifactManifestHash,
      workerReceiptHash: pdeWorkerReceipt.receiptHash,
      externalActionPerformed: false,
    },
  );
  const pdeScientificReceipt = record(
    'CanonicalPdePoisson2dGpuScientificReceipt',
    'canonicalPdePoisson2dGpuScientificReceiptHash',
    {
      version: 1,
      kind: 'CanonicalPdePoisson2dGpuScientificReceipt',
      status: 'canonical_pde_poisson_2d_gpu_scientifically_verified_non_promotable',
      gpuReceipt: pdeGpuReceipt,
      cpuOracleAssurance: { status: 'fixture-independent-oracle-bound' },
      productionPromotionEligible: false,
      blockers: ['external-production-authority-required'],
    },
  );
  const deepLearningPaths = [
    'model-spec.json', 'tensor-bundle.bin', 'training-predictions.json',
    'training-summary.json', 'training-trace.json',
  ];
  const deepLearningArtifacts = deepLearningPaths.map(
    (selectedPath) => artifact(content, selectedPath),
  );
  const deepLearningWorkerReceipt = workerReceipt(
    deepLearningArtifacts,
    'deep-learning',
  );
  const trainingExecutionReceipt = record(
    'DeepLearningTrainingExecutionReceipt',
    'deepLearningTrainingExecutionReceiptHash',
    {
      version: 1,
      kind: 'DeepLearningTrainingExecutionReceipt',
      status: 'deep_learning_training_execution_recorded',
      trainingRunId: executionPlan.tasks[1].trainingRunId,
      metricTraceArtifactHash: artifact(content, 'training-trace.json').sha256,
      checkpointManifest: {
        checkpointArtifactHash: artifact(content, 'tensor-bundle.bin').sha256,
        tensorBundleArtifactBytes: artifact(content, 'tensor-bundle.bin').bytes,
      },
      externalActionPerformed: false,
    },
  );
  const deepLearningReceipt = record(
    'CanonicalCupyDeepLearningTrainingReceipt',
    'canonicalCupyDeepLearningTrainingReceiptHash',
    {
      version: 1,
      kind: 'CanonicalCupyDeepLearningTrainingReceipt',
      status: 'canonical_cupy_deep_learning_training_recorded_non_promotable',
      trainingRunId: executionPlan.tasks[1].trainingRunId,
      workerReceiptHash: deepLearningWorkerReceipt.receiptHash,
      workerReceipt: deepLearningWorkerReceipt,
      workerArtifactManifestHash:
        deepLearningWorkerReceipt.artifactManifestHash,
      artifacts: deepLearningWorkerReceipt.artifacts,
      trainingExecutionReceiptHash:
        trainingExecutionReceipt.deepLearningTrainingExecutionReceiptHash,
      trainingExecutionReceipt,
      modelSpecificationArtifactHash: artifact(content, 'model-spec.json').sha256,
      trainingPredictionsArtifactHash:
        artifact(content, 'training-predictions.json').sha256,
      trainingSummaryArtifactHash:
        artifact(content, 'training-summary.json').sha256,
      productionPromotionEligible: false,
      blockers: ['external-production-authority-required'],
      externalActionPerformed: false,
    },
  );
  const taskResults = [
    {
      task: executionPlan.tasks[0],
      receipt: pdeScientificReceipt,
      receiptHash:
        pdeScientificReceipt.canonicalPdePoisson2dGpuScientificReceiptHash,
    },
    {
      task: executionPlan.tasks[1],
      receipt: deepLearningReceipt,
      receiptHash:
        deepLearningReceipt.canonicalCupyDeepLearningTrainingReceiptHash,
    },
  ].map(({ task, receipt, receiptHash }) => record(
    'GpuScientificCampaignTaskResult',
    'gpuScientificCampaignTaskResultHash',
    {
      version: 1,
      kind: 'GpuScientificCampaignTaskResult',
      taskType: task.taskType,
      taskHash: task.gpuScientificCampaignTaskHash,
      status: 'gpu_scientific_campaign_task_completed_non_promotable',
      receiptHash,
      receipt,
      blockers: ['external-production-authority-required'],
    },
  ));
  const executionResult = record(
    'GpuScientificCampaignExecutionResult',
    'gpuScientificCampaignExecutionResultHash',
    {
      version: 1,
      kind: 'GpuScientificCampaignExecutionResult',
      status: 'gpu_scientific_campaign_execution_completed_non_promotable',
      campaignId: CAMPAIGN_ID,
      paperId: PAPER_ID,
      campaignPlanHash: campaign.spec.campaignPlanHash,
      nodeId: node.nodeId,
      nodeKind: node.kind,
      attemptId: node.attemptId,
      leaseGeneration: node.leaseGeneration,
      gpuScientificCampaignAttemptAuthorityHash:
        attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
      executionPlanHash:
        executionPlan.gpuScientificCampaignExecutionPlanHash,
      taskResultHashes: taskResults.map(
        (item) => item.gpuScientificCampaignTaskResultHash,
      ),
      taskResults,
      executionCompletedAtEpochMs: Date.parse(CREATED_AT),
      productionQualified: false,
      promotionEligible: false,
      blockers: ['external-production-authority-required'],
      networkActionPerformed: false,
      externalActionPerformed: false,
    },
  );
  return {
    root,
    runtimeRoot,
    packageDir,
    campaign,
    node,
    executionPlan,
    executionResult,
    attemptRoot,
    pdeRoot,
    deepLearningRoot,
  };
}

function materialize(fixture) {
  return materializeGpuScientificArtifactBodyArchiveSync({
    runtimeRoot: fixture.runtimeRoot,
    packageDir: fixture.packageDir,
    campaign: fixture.campaign,
    node: fixture.node,
    executionPlan: fixture.executionPlan,
    executionResult: fixture.executionResult,
    createdAt: CREATED_AT,
  });
}

test('materializer copies the exact nine receipt-bound bodies and remains offline-verifiable after source deletion', (t) => {
  const fixture = createFixture(t);
  const inspected = inspectGpuScientificArtifactBodyArchiveSourceSync({
    runtimeRoot: fixture.runtimeRoot,
    campaign: fixture.campaign,
    node: fixture.node,
    executionPlan: fixture.executionPlan,
    executionResult: fixture.executionResult,
  });
  assert.equal(inspected.sourceBodyCount, 9);
  assert.equal(inspected.manifest.createdAt, CREATED_AT);
  assert.equal(fs.existsSync(path.join(
    fixture.packageDir,
    GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH,
  )), false);
  const archived = materialize(fixture);
  assert.equal(archived.status,
    'gpu_scientific_artifact_body_archive_materialized');
  assert.equal(archived.manifest.bodyCount, 9);
  assert.equal(archived.bodyFiles.length, 9);
  assert.equal(archived.allFiles.length, 10);
  assert.equal(archived.casFallbackUsed, false);
  assert.deepEqual(archived.manifest, inspected.manifest);
  assert.match(archived.manifest.scientificOutputCommitmentHash,
    /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    archived.manifest.originalExecutionProcessIdentityHashes,
    {
      pde: fixture.executionResult.taskResults[0].receipt.gpuReceipt
        .artifactManifest.osSandboxWorkerReceipt.executionProcessIdentityHash,
      deepLearning: fixture.executionResult.taskResults[1].receipt
        .workerReceipt.executionProcessIdentityHash,
    },
  );
  assert.equal(
    verifyGpuScientificArtifactBodyArchiveManifest(archived.manifest).valid,
    true,
  );
  for (const file of archived.allFiles) {
    const stat = fs.lstatSync(path.join(
      fixture.packageDir,
      ...file.packageRelativePath.split('/'),
    ));
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o444);
  }
  fs.rmSync(fixture.attemptRoot, { recursive: true, force: true });
  const offline = verifyOfflineGpuScientificArtifactBodyArchiveDirectorySync({
    packageDir: fixture.packageDir,
    expected: {
      gpuScientificArtifactBodyArchiveManifestHash:
        archived.manifest.gpuScientificArtifactBodyArchiveManifestHash,
    },
  });
  assert.equal(offline.valid, true, JSON.stringify(offline.blockers));
  assert.equal(offline.verifiedEntries.length, 9);
  assert.equal(offline.casFallbackUsed, false);
});

test('contract rejects an extra body, traversal alias, and declared size overflow', (t) => {
  const fixture = createFixture(t);
  const archived = materialize(fixture);
  const base = {
    ...archived.manifest,
  };
  delete base.gpuScientificArtifactBodyArchiveManifestHash;
  for (const mutate of [
    (entries) => entries.push({ ...entries[0], role: 'extra_body' }),
    (entries) => { entries[0].producerRelativePath = '../model-spec.json'; },
    (entries) => { entries[0].bytes = 64 * 1024 * 1024 + 1; },
  ]) {
    const entries = structuredClone(archived.manifest.entries);
    mutate(entries);
    assert.throws(() => buildGpuScientificArtifactBodyArchiveManifest({
      ...base,
      entries,
    }), /gpu_scientific_artifact_body_archive_manifest_invalid/);
  }
});

test('scientific output commitment excludes attempts, time, process, and receipt identity but binds bodies', (t) => {
  const fixture = createFixture(t);
  const original = materialize(fixture).manifest;
  const replayEntries = structuredClone(original.entries).map((entry) => ({
    ...entry,
    sourceTaskResultHash: entry.taskType === 'pde-poisson-2d-gpu-v1'
      ? H('replay-pde-task-result') : H('replay-deep-learning-task-result'),
    sourceScientificReceiptHash: entry.taskType === 'pde-poisson-2d-gpu-v1'
      ? H('replay-pde-receipt') : H('replay-deep-learning-receipt'),
    sourceArtifactEvidenceHash: entry.taskType === 'pde-poisson-2d-gpu-v1'
      ? H('replay-pde-manifest') : H('replay-deep-learning-execution'),
    sourceWorkerReceiptHash: entry.taskType === 'pde-poisson-2d-gpu-v1'
      ? H('replay-pde-worker') : H('replay-deep-learning-worker'),
  }));
  const replay = buildGpuScientificArtifactBodyArchiveManifest({
    ...original,
    attemptId: 'independent-replay-attempt',
    leaseGeneration: 9,
    gpuScientificCampaignAttemptAuthorityHash: H('replay-attempt-authority'),
    executionResultHash: H('replay-execution-result'),
    pdeTaskResultHash: H('replay-pde-task-result'),
    pdeScientificReceiptHash: H('replay-pde-receipt'),
    pdeArtifactManifestHash: H('replay-pde-manifest'),
    pdeWorkerReceiptHash: H('replay-pde-worker'),
    deepLearningTaskResultHash: H('replay-deep-learning-task-result'),
    deepLearningTrainingReceiptHash: H('replay-deep-learning-receipt'),
    deepLearningTrainingExecutionReceiptHash:
      H('replay-deep-learning-execution'),
    deepLearningWorkerReceiptHash: H('replay-deep-learning-worker'),
    originalExecutionProcessIdentityHashes: {
      pde: H('replay-pde-process'),
      deepLearning: H('replay-deep-learning-process'),
    },
    runtimeEnvironmentBomHashes: {
      pde: H('replay-pde-full-environment-bom'),
      deepLearning: H('replay-deep-learning-full-environment-bom'),
    },
    entries: replayEntries,
    createdAt: '2026-08-14T05:00:00.000Z',
  });
  assert.equal(
    replay.scientificOutputCommitmentHash,
    original.scientificOutputCommitmentHash,
  );
  assert.notEqual(
    replay.gpuScientificArtifactBodyArchiveManifestHash,
    original.gpuScientificArtifactBodyArchiveManifestHash,
  );
  const changedEntries = structuredClone(replayEntries);
  changedEntries[0].sha256 = H('changed-scientific-body');
  const changed = buildGpuScientificArtifactBodyArchiveManifest({
    ...replay,
    entries: changedEntries,
  });
  assert.notEqual(
    changed.scientificOutputCommitmentHash,
    original.scientificOutputCommitmentHash,
  );
});

test('offline verifier fails closed on body tamper and exact-directory extras', (t) => {
  const fixture = createFixture(t);
  materialize(fixture);
  const body = path.join(
    fixture.packageDir,
    'evidence/gpu-scientific/deep-learning/training-summary.json',
  );
  fs.chmodSync(body, 0o600);
  fs.appendFileSync(body, 'tamper\n');
  let verification = verifyOfflineGpuScientificArtifactBodyArchiveDirectorySync({
    packageDir: fixture.packageDir,
  });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.some((blocker) => (
    blocker.includes('gpu_scientific_artifact_body_archive_body_invalid')
  )));

  const other = createFixture(t);
  materialize(other);
  fs.writeFileSync(path.join(
    other.packageDir,
    'evidence/gpu-scientific/unexpected.bin',
  ), 'extra', { mode: 0o400 });
  verification = verifyOfflineGpuScientificArtifactBodyArchiveDirectorySync({
    packageDir: other.packageDir,
  });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes(
    'gpu_scientific_artifact_body_archive_directory_set_invalid',
  ));
});

test('offline verifier rejects symlink and hardlink substitutions even when bytes match', (t) => {
  for (const substitution of ['symlink', 'hardlink']) {
    const fixture = createFixture(t);
    materialize(fixture);
    const packaged = path.join(
      fixture.packageDir,
      'evidence/gpu-scientific/deep-learning/model-spec.json',
    );
    const source = path.join(fixture.deepLearningRoot, 'model-spec.json');
    fs.unlinkSync(packaged);
    if (substitution === 'symlink') fs.symlinkSync(source, packaged);
    else fs.linkSync(source, packaged);
    const verification = verifyOfflineGpuScientificArtifactBodyArchiveDirectorySync({
      packageDir: fixture.packageDir,
    });
    assert.equal(verification.valid, false, substitution);
    assert.ok(verification.blockers.some((blocker) => (
      blocker.includes('gpu_scientific_artifact_body_archive_body_invalid')
    )), substitution);
  }
});

test('materializer ignores arbitrary receipt paths, derives canonical roots, and rolls back receipt mismatches', (t) => {
  const forged = createFixture(t, {
    pdeOutputDirectoryOverride: path.join(os.tmpdir(), 'forged-pde-output'),
  });
  assert.throws(() => materialize(forged),
    /gpu_scientific_artifact_body_archive_source_lineage_invalid/);
  assert.equal(fs.existsSync(path.join(
    forged.packageDir,
    GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH,
  )), false);

  const changed = createFixture(t);
  fs.appendFileSync(
    path.join(changed.deepLearningRoot, 'tensor-bundle.bin'),
    Buffer.from('changed'),
  );
  assert.throws(() => materialize(changed),
    /gpu_scientific_artifact_body_archive_source_(?:size_invalid|receipt_mismatch)/);
  const files = fs.existsSync(path.join(changed.packageDir, 'evidence/gpu-scientific'))
    ? fs.readdirSync(path.join(changed.packageDir, 'evidence/gpu-scientific'), {
      recursive: true,
      withFileTypes: true,
    }).filter((entry) => entry.isFile()).length
    : 0;
  assert.equal(files, 0);
});

test('successful rollback reaps its cleanup lane across repeated archive failures', (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-gpu-body-archive-cleanup-lifecycle-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageDir = path.join(root, 'package');
  fs.mkdirSync(path.join(packageDir, 'evidence', 'gpu-scientific'), {
    recursive: true,
    mode: 0o700,
  });
  const relative = 'evidence/gpu-scientific/retry-body.bin';
  const content = Buffer.from('owned-archive-body\n');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const installed = installGpuScientificArtifactBodyArchiveFileSync({
      packageDir,
      destinationRelative: relative,
      maximumBytes: 1024,
      expectedHash: hashBytes(content),
      expectedBytes: content.length,
      content,
    });
    rollbackGpuScientificArtifactBodyArchiveFilesSync([installed.owner]);
    assert.equal(fs.existsSync(path.join(packageDir, ...relative.split('/'))), false);
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.startsWith(
        '.gpu-archive-cleanup-',
      )),
      [],
    );
  }
});

test('rollback preserves replacements at controlled cleanup windows and bounds retry quarantine', (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-gpu-body-archive-cleanup-race-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = Buffer.from('owned-archive-body\n');
  const replacement = Buffer.from('concurrent-replacement-must-survive\n');
  const createCase = (label, filename) => {
    const packageDir = path.join(root, `package-${label}`);
    const archiveParent = path.join(packageDir, 'evidence', 'gpu-scientific');
    fs.mkdirSync(archiveParent, { recursive: true, mode: 0o700 });
    const relative = `evidence/gpu-scientific/${filename}`;
    return {
      packageDir,
      archiveParent,
      relative,
      target: path.join(packageDir, ...relative.split('/')),
      installed: installGpuScientificArtifactBodyArchiveFileSync({
        packageDir,
        destinationRelative: relative,
        maximumBytes: 1024,
        expectedHash: hashBytes(original),
        expectedBytes: original.length,
        content: original,
      }),
    };
  };

  const raced = createCase('source-replacement', 'raced-body.bin');
  const displaced = path.join(raced.archiveParent, 'authorized-original.saved');
  let injected = false;
  let cleanupError;
  assert.throws(
    () => rollbackGpuScientificArtifactBodyArchiveFilesSync(
      [raced.installed.owner],
      { faultInjector(event) {
        if (event.stage !== 'before_owned_entry_no_clobber_move') return;
        injected = true;
        fs.renameSync(raced.target, displaced);
        fs.writeFileSync(raced.target, replacement, { mode: 0o444 });
      } },
    ),
    (error) => {
      cleanupError = error;
      return error?.code
        === 'gpu_scientific_artifact_body_archive_cleanup_identity_changed';
    },
  );
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(displaced, 'utf8'), original.toString('utf8'));
  assert.equal(fs.readFileSync(raced.target, 'utf8'), replacement.toString('utf8'));
  const quarantine = path.join(root, cleanupError.quarantineName);
  const quarantined = path.join(quarantine, 'owned-entry');
  assert.equal(
    fs.readFileSync(quarantined, 'utf8'),
    replacement.toString('utf8'),
  );
  const targetStat = fs.lstatSync(raced.target, { bigint: true });
  const quarantinedStat = fs.lstatSync(quarantined, { bigint: true });
  assert.equal(targetStat.dev, quarantinedStat.dev);
  assert.equal(targetStat.ino, quarantinedStat.ino);
  assert.equal(targetStat.nlink, 2n);

  const collision = createCase('destination-collision', 'collision-body.bin');
  let injectedDestination;
  assert.throws(
    () => rollbackGpuScientificArtifactBodyArchiveFilesSync(
      [collision.installed.owner],
      { faultInjector(event) {
        if (event.stage !== 'before_owned_entry_no_clobber_move') return;
        injectedDestination = path.join(
          root,
          event.quarantineName,
          'owned-entry',
        );
        fs.writeFileSync(
          path.join(event.quarantinePath, 'owned-entry'),
          replacement,
          { mode: 0o444 },
        );
      } },
    ),
    (error) => error?.code
      === 'gpu_scientific_artifact_body_archive_cleanup_identity_changed',
  );
  assert.equal(fs.readFileSync(collision.target, 'utf8'), original.toString('utf8'));
  assert.equal(
    fs.readFileSync(injectedDestination, 'utf8'),
    replacement.toString('utf8'),
  );

  const retained = createCase('final-replacement', 'retained-body.bin');
  let retainedOriginal;
  let retainedReplacement;
  assert.throws(
    () => rollbackGpuScientificArtifactBodyArchiveFilesSync(
      [retained.installed.owner],
      { faultInjector(event) {
        if (event.stage !== 'before_quarantine_unlink') return;
        retainedOriginal = path.join(root, event.quarantineName, 'owned.saved');
        retainedReplacement = path.join(root, event.quarantineName, 'owned-entry');
        fs.renameSync(
          path.join(event.quarantinePath, 'owned-entry'),
          path.join(event.quarantinePath, 'owned.saved'),
        );
        fs.writeFileSync(
          path.join(event.quarantinePath, 'owned-entry'),
          replacement,
          { mode: 0o444 },
        );
      } },
    ),
    (error) => error?.code
      === 'gpu_scientific_artifact_body_archive_cleanup_identity_changed',
  );
  assert.equal(fs.existsSync(retained.target), false);
  assert.equal(fs.readFileSync(retainedOriginal, 'utf8'), original.toString('utf8'));
  assert.equal(
    fs.readFileSync(retainedReplacement, 'utf8'),
    replacement.toString('utf8'),
  );

  const beforeRetry = fs.readdirSync(root)
    .filter((name) => name.startsWith('.gpu-archive-cleanup-'))
    .sort();
  const retry = installGpuScientificArtifactBodyArchiveFileSync({
    packageDir: retained.packageDir,
    destinationRelative: 'evidence/gpu-scientific/retry-after-tamper.bin',
    maximumBytes: 1024,
    expectedHash: hashBytes(original),
    expectedBytes: original.length,
    content: original,
  });
  assert.throws(
    () => rollbackGpuScientificArtifactBodyArchiveFilesSync([retry.owner]),
    (error) => error?.code
      === 'gpu_scientific_artifact_body_archive_cleanup_identity_changed',
  );
  assert.deepEqual(
    fs.readdirSync(root)
      .filter((name) => name.startsWith('.gpu-archive-cleanup-'))
      .sort(),
    beforeRetry,
  );
});
