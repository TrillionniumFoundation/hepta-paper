import fs from 'node:fs';
import path from 'node:path';
import {
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS,
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH,
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MAXIMUM_MANIFEST_BYTES,
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MAXIMUM_TOTAL_BYTES,
  buildGpuScientificArtifactBodyArchiveManifest,
  verifyGpuScientificArtifactBodyArchiveManifest,
} from '../../paper-domain/automation/gpu-scientific-artifact-body-archive-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectScopedPathSync, readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { safeRetentionNodeKey } from '../automation/runtime-retention-scope-repository.mjs';
import {
  assertOpenedParentStillScoped,
  descriptorEntryPath,
  ensureScopedDirectorySync,
  openScopedDirectoryChain,
  verifiedRoot,
} from '../runtime/scoped-file-materialization-path-io.mjs';
import {
  closeGpuScientificArtifactBodyArchiveFileOwner,
  installGpuScientificArtifactBodyArchiveFileSync,
  rollbackGpuScientificArtifactBodyArchiveFilesSync,
} from './gpu-scientific-artifact-body-archive-file-repository.mjs';
import {
  PDE_TASK_TYPE,
  deriveGpuScientificArtifactBodyArchiveRuntimeBindings,
  validateGpuScientificArtifactBodyArchiveDeepLearningSource,
  validateGpuScientificArtifactBodyArchivePdeSource,
  validateGpuScientificArtifactBodyArchiveResultAuthority,
} from './gpu-scientific-artifact-body-archive-source-validation.mjs';

const ARCHIVE_ROOT_RELATIVE = 'evidence/gpu-scientific';

const EXPECTED_ARCHIVE_DIRECTORY_ENTRIES = Object.freeze({
  'evidence/gpu-scientific': Object.freeze([
    'ARTIFACT_BODY_ARCHIVE_MANIFEST.json', 'deep-learning', 'pde',
  ]),
  'evidence/gpu-scientific/deep-learning': Object.freeze([
    'model-spec.json', 'tensor-bundle.bin', 'training-predictions.json',
    'training-summary.json', 'training-trace.json',
  ]),
  'evidence/gpu-scientific/pde': Object.freeze([
    'producer-diagnostics.json', 'solutions',
  ]),
  'evidence/gpu-scientific/pde/solutions': Object.freeze([
    'n127.f64le', 'n31.f64le', 'n63.f64le',
  ]),
});

function deriveSourceEvidence({
  runtimeRoot,
  campaign,
  node,
  executionPlan,
  executionResult,
}) {
  const runtime = path.resolve(runtimeRoot || '.');
  if (!path.isAbsolute(String(runtimeRoot || ''))
    || runtime === path.parse(runtime).root) {
    throw new Error('gpu_scientific_artifact_body_archive_runtime_root_invalid');
  }
  const authority = validateGpuScientificArtifactBodyArchiveResultAuthority({
    campaign,
    node,
    executionPlan,
    executionResult,
  });
  const pde = validateGpuScientificArtifactBodyArchivePdeSource(
    authority.pdeTaskResult,
  );
  const deepLearning = validateGpuScientificArtifactBodyArchiveDeepLearningSource(
    authority.deepLearningTaskResult,
    executionPlan.tasks[1].trainingRunId,
  );
  const attemptRoot = path.join(
    runtime,
    'automation-artifacts',
    safeRetentionNodeKey(campaign.campaignId),
    `gpu-scientific-attempt-${authority.attemptAuthority
      .gpuScientificCampaignAttemptAuthorityHash.slice('sha256:'.length)}`,
  );
  const pdeRoot = path.join(
    attemptRoot,
    'pde-poisson-2d',
    `pde-${pde.gpuReceipt.requestHash.slice('sha256:'.length)}`,
  );
  const deepLearningRoot = path.join(
    attemptRoot,
    'deep-learning-cupy-mlp',
    `training-${hashRecord('DeepLearningTrainingRunDirectory', {
      trainingRunId: executionPlan.tasks[1].trainingRunId,
    }).slice('sha256:'.length)}`,
  );
  if (!isPathWithin(runtime, attemptRoot)
    || !isPathWithin(attemptRoot, pdeRoot)
    || !isPathWithin(attemptRoot, deepLearningRoot)
    || path.resolve(String(pde.gpuReceipt.outputDirectory || '')) !== pdeRoot) {
    throw new Error('gpu_scientific_artifact_body_archive_source_lineage_invalid');
  }
  return {
    authority,
    pde,
    deepLearning,
    runtimeBindings: deriveGpuScientificArtifactBodyArchiveRuntimeBindings({
      pde,
      deepLearning,
      executionPlan,
    }),
    pdeRoot,
    deepLearningRoot,
  };
}

function manifestExpectedBindings({ campaign, node, executionPlan, executionResult }) {
  return {
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    nodeId: node.nodeId,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    executionPlanHash: executionPlan.gpuScientificCampaignExecutionPlanHash,
    executionResultHash:
      executionResult.gpuScientificCampaignExecutionResultHash,
  };
}

function stableArchiveCreatedAt(executionResult, requestedCreatedAt) {
  const completedAt = Number(executionResult?.executionCompletedAtEpochMs);
  if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
    throw new Error('gpu_scientific_artifact_body_archive_created_at_invalid');
  }
  let stable;
  try { stable = new Date(completedAt).toISOString(); }
  catch {
    throw new Error('gpu_scientific_artifact_body_archive_created_at_invalid');
  }
  if (requestedCreatedAt !== null && requestedCreatedAt !== undefined
    && requestedCreatedAt !== stable) {
    throw new Error('gpu_scientific_artifact_body_archive_created_at_unstable');
  }
  return stable;
}

function sourceArchiveEntries(source) {
  const pdeTaskResult = source.authority.pdeTaskResult;
  const deepLearningTaskResult = source.authority.deepLearningTaskResult;
  return GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS.map(
    (specification) => {
      const selected = specification.taskType === PDE_TASK_TYPE
        ? source.pde : source.deepLearning;
      const sourceRoot = specification.taskType === PDE_TASK_TYPE
        ? source.pdeRoot : source.deepLearningRoot;
      const declared = selected.artifactMap.get(specification.producerRelativePath);
      if (!declared || declared.bytes > specification.maximumBytes
        || (specification.exactBytes !== null
          && declared.bytes !== specification.exactBytes)) {
        throw new Error('gpu_scientific_artifact_body_archive_declared_size_invalid');
      }
      const read = readScopedFileSync({
        scopeRoot: sourceRoot,
        candidate: path.join(
          sourceRoot,
          ...specification.producerRelativePath.split('/'),
        ),
        maximumBytes: specification.maximumBytes,
      });
      if (read.status !== 'scoped_file_read_verified'
        || read.hash !== declared.sha256
        || read.bytes !== declared.bytes) {
        throw new Error('gpu_scientific_artifact_body_archive_source_receipt_mismatch');
      }
      if (specification.producerRelativePath.endsWith('.json')) {
        try { JSON.parse(read.content.toString('utf8')); }
        catch {
          throw new Error('gpu_scientific_artifact_body_archive_source_json_invalid');
        }
      }
      const entry = {
        taskType: specification.taskType,
        role: specification.role,
        producerRelativePath: specification.producerRelativePath,
        packageRelativePath: specification.packageRelativePath,
        sha256: declared.sha256,
        bytes: declared.bytes,
        sourceTaskResultHash: specification.taskType === PDE_TASK_TYPE
          ? pdeTaskResult.gpuScientificCampaignTaskResultHash
          : deepLearningTaskResult.gpuScientificCampaignTaskResultHash,
        sourceScientificReceiptHash: specification.taskType === PDE_TASK_TYPE
          ? source.pde.scientificReceipt
            .canonicalPdePoisson2dGpuScientificReceiptHash
          : source.deepLearning.receipt
            .canonicalCupyDeepLearningTrainingReceiptHash,
        sourceArtifactEvidenceHash: specification.taskType === PDE_TASK_TYPE
          ? source.pde.artifactManifest.pdePoisson2dGpuArtifactManifestHash
          : source.deepLearning.trainingExecutionReceipt
            .deepLearningTrainingExecutionReceiptHash,
        sourceWorkerReceiptHash: specification.taskType === PDE_TASK_TYPE
          ? source.pde.workerReceipt.receiptHash
          : source.deepLearning.workerReceipt.receiptHash,
      };
      return Object.freeze({
        specification,
        sourceRoot,
        sourceRelativePath: specification.producerRelativePath,
        expectedHash: read.hash,
        expectedBytes: read.bytes,
        entry: Object.freeze(entry),
      });
    },
  );
}

export function inspectGpuScientificArtifactBodyArchiveSourceSync({
  runtimeRoot,
  campaign,
  node,
  executionPlan,
  executionResult,
  createdAt = null,
} = {}) {
  const source = deriveSourceEvidence({
    runtimeRoot,
    campaign,
    node,
    executionPlan,
    executionResult,
  });
  const sourceDescriptors = sourceArchiveEntries(source);
  const entries = sourceDescriptors.map((descriptor) => descriptor.entry);
  const pdeTaskResult = source.authority.pdeTaskResult;
  const deepLearningTaskResult = source.authority.deepLearningTaskResult;
  const manifest = buildGpuScientificArtifactBodyArchiveManifest({
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    nodeId: node.nodeId,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    gpuScientificCampaignAttemptAuthorityHash:
      source.authority.attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
    executionPlanHash: executionPlan.gpuScientificCampaignExecutionPlanHash,
    executionResultHash:
      executionResult.gpuScientificCampaignExecutionResultHash,
    taskSetHash: executionPlan.taskSetHash,
    pdeTaskHash: executionPlan.tasks[0].gpuScientificCampaignTaskHash,
    deepLearningTaskHash:
      executionPlan.tasks[1].gpuScientificCampaignTaskHash,
    gpuDeviceSelector: executionPlan.gpuDeviceSelector,
    ...source.runtimeBindings,
    pdeTaskResultHash: pdeTaskResult.gpuScientificCampaignTaskResultHash,
    pdeScientificReceiptHash:
      source.pde.scientificReceipt
        .canonicalPdePoisson2dGpuScientificReceiptHash,
    pdeArtifactManifestHash:
      source.pde.artifactManifest.pdePoisson2dGpuArtifactManifestHash,
    pdeWorkerReceiptHash: source.pde.workerReceipt.receiptHash,
    deepLearningTaskResultHash:
      deepLearningTaskResult.gpuScientificCampaignTaskResultHash,
    deepLearningTrainingReceiptHash:
      source.deepLearning.receipt.canonicalCupyDeepLearningTrainingReceiptHash,
    deepLearningTrainingExecutionReceiptHash:
      source.deepLearning.trainingExecutionReceipt
        .deepLearningTrainingExecutionReceiptHash,
    deepLearningWorkerReceiptHash:
      source.deepLearning.workerReceipt.receiptHash,
    entries,
    createdAt: stableArchiveCreatedAt(source.authority.result, createdAt),
  });
  return Object.freeze({
    status: 'gpu_scientific_artifact_body_archive_source_verified',
    manifest,
    sourceDescriptors: Object.freeze(sourceDescriptors),
    sourceBodyCount: sourceDescriptors.length,
    sourceTotalBytes: sourceDescriptors.reduce(
      (total, descriptor) => total + descriptor.expectedBytes,
      0,
    ),
    casFallbackUsed: false,
  });
}

function directoryEntrySetValid(packageDir, relative, expectedNames) {
  const scope = verifiedRoot(packageDir);
  const opened = openScopedDirectoryChain(scope, relative, { create: false });
  try {
    const names = fs.readdirSync(
      descriptorEntryPath(opened.descriptor, '.'),
    ).sort();
    assertOpenedParentStillScoped(opened);
    return JSON.stringify(names) === JSON.stringify([...expectedNames].sort());
  } finally {
    fs.closeSync(opened.descriptor);
  }
}

export function verifyOfflineGpuScientificArtifactBodyArchiveDirectorySync({
  packageDir,
  expected = {},
} = {}) {
  const blockers = [];
  const root = path.resolve(packageDir || '.');
  let manifest = null;
  let manifestRead = null;
  const identity = inspectScopedPathSync({
    scopeRoot: root,
    candidate: root,
    expect: 'directory',
    forbidHardlinks: false,
  });
  if (identity.blockers.length) {
    blockers.push('gpu_scientific_artifact_body_archive_package_root_unsafe');
  }
  if (!blockers.length) {
    manifestRead = readScopedFileSync({
      scopeRoot: root,
      candidate: path.join(root, ...GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH
        .split('/')),
      maximumBytes: GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MAXIMUM_MANIFEST_BYTES,
    });
    if (manifestRead.status !== 'scoped_file_read_verified') {
      blockers.push('gpu_scientific_artifact_body_archive_manifest_file_invalid');
    } else {
      try { manifest = JSON.parse(manifestRead.content.toString('utf8')); }
      catch {
        blockers.push('gpu_scientific_artifact_body_archive_manifest_json_invalid');
      }
    }
  }
  if (manifest) {
    const verification = verifyGpuScientificArtifactBodyArchiveManifest(
      manifest,
      expected,
    );
    blockers.push(...verification.blockers);
  }
  if (!blockers.length) {
    try {
      for (const [relative, expectedNames] of Object.entries(
        EXPECTED_ARCHIVE_DIRECTORY_ENTRIES,
      )) {
        if (!directoryEntrySetValid(root, relative, expectedNames)) {
          blockers.push('gpu_scientific_artifact_body_archive_directory_set_invalid');
          break;
        }
      }
    } catch {
      blockers.push('gpu_scientific_artifact_body_archive_directory_set_invalid');
    }
  }
  const verifiedEntries = [];
  if (!blockers.length) {
    let totalBytes = 0;
    for (const entry of manifest.entries) {
      const specification = GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS
        .find((item) => item.packageRelativePath === entry.packageRelativePath);
      const read = readScopedFileSync({
        scopeRoot: root,
        candidate: path.join(root, ...entry.packageRelativePath.split('/')),
        maximumBytes: specification.maximumBytes,
      });
      if (read.status !== 'scoped_file_read_verified'
        || read.hash !== entry.sha256
        || read.bytes !== entry.bytes) {
        blockers.push(
          `gpu_scientific_artifact_body_archive_body_invalid:${entry.role}`,
        );
        continue;
      }
      if (entry.packageRelativePath.endsWith('.json')) {
        try { JSON.parse(read.content.toString('utf8')); }
        catch {
          blockers.push(
            `gpu_scientific_artifact_body_archive_json_body_invalid:${entry.role}`,
          );
          continue;
        }
      }
      totalBytes += read.bytes;
      if (totalBytes > GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MAXIMUM_TOTAL_BYTES) {
        blockers.push('gpu_scientific_artifact_body_archive_total_bytes_exceeded');
        break;
      }
      verifiedEntries.push(Object.freeze({
        role: entry.role,
        packageRelativePath: entry.packageRelativePath,
        hash: read.hash,
        bytes: read.bytes,
      }));
    }
    if (totalBytes !== manifest.totalBytes
      || verifiedEntries.length !== manifest.bodyCount) {
      blockers.push('gpu_scientific_artifact_body_archive_body_count_invalid');
    }
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    manifest,
    manifestFileHash: manifestRead?.hash || null,
    manifestFileBytes: manifestRead?.bytes ?? null,
    verifiedEntries: Object.freeze(verifiedEntries),
    casFallbackUsed: false,
  });
}

export function materializeGpuScientificArtifactBodyArchiveSync({
  runtimeRoot,
  packageDir,
  campaign,
  node,
  executionPlan,
  executionResult,
  createdAt = null,
} = {}) {
  const packageRoot = path.resolve(packageDir || '.');
  if (!path.isAbsolute(String(packageDir || ''))
    || packageRoot === path.parse(packageRoot).root) {
    throw new Error('gpu_scientific_artifact_body_archive_package_root_invalid');
  }
  verifiedRoot(packageRoot);
  const inspection = inspectGpuScientificArtifactBodyArchiveSourceSync({
    runtimeRoot,
    campaign,
    node,
    executionPlan,
    executionResult,
    createdAt,
  });
  ensureScopedDirectorySync({ scopeRoot: packageRoot, relative: ARCHIVE_ROOT_RELATIVE });
  const owners = [];
  try {
    for (const descriptor of inspection.sourceDescriptors) {
      const installed = installGpuScientificArtifactBodyArchiveFileSync({
        packageDir: packageRoot,
        destinationRelative: descriptor.specification.packageRelativePath,
        maximumBytes: descriptor.specification.maximumBytes,
        expectedHash: descriptor.expectedHash,
        expectedBytes: descriptor.expectedBytes,
        sourceRoot: descriptor.sourceRoot,
        sourceRelative: descriptor.sourceRelativePath,
      });
      owners.push(installed.owner);
    }
    const manifest = inspection.manifest;
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const manifestInstalled = installGpuScientificArtifactBodyArchiveFileSync({
      packageDir: packageRoot,
      destinationRelative: GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH,
      maximumBytes: GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MAXIMUM_MANIFEST_BYTES,
      expectedHash: hashBytes(manifestBytes),
      expectedBytes: manifestBytes.length,
      content: manifestBytes,
    });
    owners.push(manifestInstalled.owner);
    const expected = {
      ...manifestExpectedBindings({
        campaign,
        node,
        executionPlan,
        executionResult,
      }),
      gpuScientificCampaignAttemptAuthorityHash:
        manifest.gpuScientificCampaignAttemptAuthorityHash,
      gpuScientificArtifactBodyArchiveManifestHash:
        manifest.gpuScientificArtifactBodyArchiveManifestHash,
      scientificOutputCommitmentHash:
        manifest.scientificOutputCommitmentHash,
    };
    const offlineVerification =
      verifyOfflineGpuScientificArtifactBodyArchiveDirectorySync({
        packageDir: packageRoot,
        expected,
      });
    if (!offlineVerification.valid) {
      throw new Error(
        `gpu_scientific_artifact_body_archive_offline_verification_failed:${offlineVerification.blockers.join(',')}`,
      );
    }
    for (const owner of owners) {
      closeGpuScientificArtifactBodyArchiveFileOwner(owner);
    }
    const bodyFiles = Object.freeze(manifest.entries.map((entry) => Object.freeze({
      role: 'gpu_scientific_artifact_body_archive_file',
      archiveRole: entry.role,
      packageRelativePath: entry.packageRelativePath,
      hash: entry.sha256,
      bytes: entry.bytes,
    })));
    const manifestFile = Object.freeze({
      role: 'gpu_scientific_artifact_body_archive_manifest',
      archiveRole: 'gpu_scientific_artifact_body_archive_manifest',
      packageRelativePath: GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH,
      hash: manifestInstalled.hash,
      bytes: manifestInstalled.bytes,
    });
    return Object.freeze({
      status: 'gpu_scientific_artifact_body_archive_materialized',
      manifest,
      manifestFile,
      bodyFiles,
      allFiles: Object.freeze([manifestFile, ...bodyFiles]),
      sourceInspectionManifestHash:
        inspection.manifest.gpuScientificArtifactBodyArchiveManifestHash,
      offlineVerification,
      casFallbackUsed: false,
    });
  } catch (error) {
    try { rollbackGpuScientificArtifactBodyArchiveFilesSync(owners); }
    catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}
