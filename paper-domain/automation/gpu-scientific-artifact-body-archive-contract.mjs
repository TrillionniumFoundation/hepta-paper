import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/;
const GPU_UUID = /^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,512}$/;

export const GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MANIFEST_PATH =
  'evidence/gpu-scientific/ARTIFACT_BODY_ARCHIVE_MANIFEST.json';
export const GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MAXIMUM_TOTAL_BYTES =
  256 * 1024 * 1024;
export const GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MAXIMUM_MANIFEST_BYTES =
  1024 * 1024;

const PDE_TASK_TYPE = 'pde-poisson-2d-gpu-v1';
const DEEP_LEARNING_TASK_TYPE = 'deep-learning-cupy-mlp-v1';
const PDE_DIAGNOSTICS_MAXIMUM_BYTES = 1024 * 1024;
const PDE_REPLAY_INPUT_MAXIMUM_BYTES = 4 * 1024 * 1024;
const DEEP_LEARNING_ARTIFACT_MAXIMUM_BYTES = 64 * 1024 * 1024;

export const GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS =
  deepFreezeJsonValue([
    {
      taskType: DEEP_LEARNING_TASK_TYPE,
      role: 'deep_learning_model_specification',
      producerRelativePath: 'model-spec.json',
      packageRelativePath: 'evidence/gpu-scientific/deep-learning/model-spec.json',
      maximumBytes: DEEP_LEARNING_ARTIFACT_MAXIMUM_BYTES,
      exactBytes: null,
      archiveSource: 'worker-artifact',
    },
    {
      taskType: DEEP_LEARNING_TASK_TYPE,
      role: 'deep_learning_training_dataset',
      producerRelativePath: 'training-dataset.json',
      packageRelativePath:
        'evidence/gpu-scientific/deep-learning/training-dataset.json',
      maximumBytes: DEEP_LEARNING_ARTIFACT_MAXIMUM_BYTES,
      exactBytes: null,
      archiveSource: 'execution-plan-derived',
    },
    {
      taskType: DEEP_LEARNING_TASK_TYPE,
      role: 'deep_learning_tensor_bundle',
      producerRelativePath: 'tensor-bundle.bin',
      packageRelativePath: 'evidence/gpu-scientific/deep-learning/tensor-bundle.bin',
      maximumBytes: DEEP_LEARNING_ARTIFACT_MAXIMUM_BYTES,
      exactBytes: null,
      archiveSource: 'worker-artifact',
    },
    {
      taskType: DEEP_LEARNING_TASK_TYPE,
      role: 'deep_learning_training_predictions',
      producerRelativePath: 'training-predictions.json',
      packageRelativePath: 'evidence/gpu-scientific/deep-learning/training-predictions.json',
      maximumBytes: DEEP_LEARNING_ARTIFACT_MAXIMUM_BYTES,
      exactBytes: null,
      archiveSource: 'worker-artifact',
    },
    {
      taskType: DEEP_LEARNING_TASK_TYPE,
      role: 'deep_learning_training_summary',
      producerRelativePath: 'training-summary.json',
      packageRelativePath: 'evidence/gpu-scientific/deep-learning/training-summary.json',
      maximumBytes: DEEP_LEARNING_ARTIFACT_MAXIMUM_BYTES,
      exactBytes: null,
      archiveSource: 'worker-artifact',
    },
    {
      taskType: DEEP_LEARNING_TASK_TYPE,
      role: 'deep_learning_training_trace',
      producerRelativePath: 'training-trace.json',
      packageRelativePath: 'evidence/gpu-scientific/deep-learning/training-trace.json',
      maximumBytes: DEEP_LEARNING_ARTIFACT_MAXIMUM_BYTES,
      exactBytes: null,
      archiveSource: 'worker-artifact',
    },
    {
      taskType: PDE_TASK_TYPE,
      role: 'pde_producer_diagnostics',
      producerRelativePath: 'producer-diagnostics.json',
      packageRelativePath: 'evidence/gpu-scientific/pde/producer-diagnostics.json',
      maximumBytes: PDE_DIAGNOSTICS_MAXIMUM_BYTES,
      exactBytes: null,
      archiveSource: 'worker-artifact',
    },
    {
      taskType: PDE_TASK_TYPE,
      role: 'pde_offline_replay_input',
      producerRelativePath: 'replay-input.json',
      packageRelativePath: 'evidence/gpu-scientific/pde/replay-input.json',
      maximumBytes: PDE_REPLAY_INPUT_MAXIMUM_BYTES,
      exactBytes: null,
      archiveSource: 'execution-result-derived',
    },
    {
      taskType: PDE_TASK_TYPE,
      role: 'pde_solution_n127',
      producerRelativePath: 'solutions/n127.f64le',
      packageRelativePath: 'evidence/gpu-scientific/pde/solutions/n127.f64le',
      maximumBytes: 127 * 127 * Float64Array.BYTES_PER_ELEMENT,
      exactBytes: 127 * 127 * Float64Array.BYTES_PER_ELEMENT,
      archiveSource: 'worker-artifact',
    },
    {
      taskType: PDE_TASK_TYPE,
      role: 'pde_solution_n31',
      producerRelativePath: 'solutions/n31.f64le',
      packageRelativePath: 'evidence/gpu-scientific/pde/solutions/n31.f64le',
      maximumBytes: 31 * 31 * Float64Array.BYTES_PER_ELEMENT,
      exactBytes: 31 * 31 * Float64Array.BYTES_PER_ELEMENT,
      archiveSource: 'worker-artifact',
    },
    {
      taskType: PDE_TASK_TYPE,
      role: 'pde_solution_n63',
      producerRelativePath: 'solutions/n63.f64le',
      packageRelativePath: 'evidence/gpu-scientific/pde/solutions/n63.f64le',
      maximumBytes: 63 * 63 * Float64Array.BYTES_PER_ELEMENT,
      exactBytes: 63 * 63 * Float64Array.BYTES_PER_ELEMENT,
      archiveSource: 'worker-artifact',
    },
  ]);

const ENTRY_KEYS = Object.freeze([
  'bytes', 'packageRelativePath', 'producerRelativePath', 'role', 'sha256',
  'sourceArtifactEvidenceHash', 'sourceScientificReceiptHash',
  'sourceTaskResultHash', 'sourceWorkerReceiptHash', 'taskType',
]);
const MANIFEST_KEYS = Object.freeze([
  'archivePolicy', 'artifactBodySetHash', 'bodyCount', 'campaignId',
  'campaignPlanHash', 'createdAt', 'deepLearningTaskResultHash',
  'deepLearningTaskHash',
  'deepLearningTrainingExecutionReceiptHash',
  'deepLearningTrainingReceiptHash', 'deepLearningWorkerReceiptHash',
  'entries', 'executionPlanHash', 'executionResultHash',
  'externalActionPerformed', 'gpuScientificArtifactBodyArchiveManifestHash',
  'gpuScientificCampaignAttemptAuthorityHash', 'gpuDeviceSelector',
  'kind', 'leaseGeneration',
  'nodeId', 'paperId', 'pdeArtifactManifestHash', 'pdeScientificReceiptHash',
  'pdeTaskHash', 'pdeTaskResultHash', 'pdeWorkerReceiptHash',
  'originalExecutionProcessIdentityHashes', 'productionPromotionEligible',
  'runtimeEnvironmentBomHashes', 'runtimeImageDigest',
  'runtimeBomComponentHashes', 'runtimePackageClosureHash',
  'scientificOutputCommitmentHash', 'scientificRuntimeBomHash', 'status',
  'taskSetHash', 'totalBytes', 'version', 'attemptId',
]);
const TASK_HASH_KEYS = Object.freeze(['deepLearning', 'pde']);
const RUNTIME_BOM_COMPONENT_KEYS = Object.freeze([
  'buildReproducibilityHash', 'determinismPolicyHash', 'gpuIdentityHash',
  'numericRuntimePolicyHash', 'runtimeClosureHash',
]);

function safeRelativePath(value) {
  const selected = String(value || '');
  return SAFE_RELATIVE_PATH.test(selected)
    && !selected.includes('\\')
    && !selected.split('/').some((part) => (
      !part || part === '.' || part === '..' || part.startsWith('-')
    ));
}

function expectedEntryLineage(manifest, taskType) {
  return taskType === PDE_TASK_TYPE
    ? {
      sourceTaskResultHash: manifest.pdeTaskResultHash,
      sourceScientificReceiptHash: manifest.pdeScientificReceiptHash,
      sourceArtifactEvidenceHash: manifest.pdeArtifactManifestHash,
      sourceWorkerReceiptHash: manifest.pdeWorkerReceiptHash,
    }
    : {
      sourceTaskResultHash: manifest.deepLearningTaskResultHash,
      sourceScientificReceiptHash: manifest.deepLearningTrainingReceiptHash,
      sourceArtifactEvidenceHash:
        manifest.deepLearningTrainingExecutionReceiptHash,
      sourceWorkerReceiptHash: manifest.deepLearningWorkerReceiptHash,
    };
}

function canonicalEntry(entry) {
  return {
    taskType: String(entry?.taskType || ''),
    role: String(entry?.role || ''),
    producerRelativePath: String(entry?.producerRelativePath || ''),
    packageRelativePath: String(entry?.packageRelativePath || ''),
    sha256: String(entry?.sha256 || '').toLowerCase(),
    bytes: Number(entry?.bytes),
    sourceTaskResultHash: String(entry?.sourceTaskResultHash || '').toLowerCase(),
    sourceScientificReceiptHash:
      String(entry?.sourceScientificReceiptHash || '').toLowerCase(),
    sourceArtifactEvidenceHash:
      String(entry?.sourceArtifactEvidenceHash || '').toLowerCase(),
    sourceWorkerReceiptHash:
      String(entry?.sourceWorkerReceiptHash || '').toLowerCase(),
  };
}

function bodySetHash(entries) {
  return hashRecord('GpuScientificArtifactBodySet', {
    version: 2,
    bodyCount: entries.length,
    entries,
  });
}

function exactHashPair(value) {
  return hasExactObjectKeys(value, TASK_HASH_KEYS)
    && SHA256.test(String(value?.pde || ''))
    && SHA256.test(String(value?.deepLearning || ''));
}

function scientificOutputEntry(entry) {
  return {
    role: entry.role,
    producerRelativePath: entry.producerRelativePath,
    packageRelativePath: entry.packageRelativePath,
    sha256: entry.sha256,
    bytes: entry.bytes,
  };
}

function exactRuntimeBomComponentSet(value) {
  return hasExactObjectKeys(value, TASK_HASH_KEYS)
    && Object.values(value).every((components) => (
      hasExactObjectKeys(components, RUNTIME_BOM_COMPONENT_KEYS)
      && Object.values(components).every((hash) => SHA256.test(String(hash || '')))
    ));
}

export function gpuScientificArtifactBodyArchiveScientificRuntimeBomHash(
  runtimeBomComponentHashes,
) {
  if (!exactRuntimeBomComponentSet(runtimeBomComponentHashes)) {
    throw new Error('gpu_scientific_runtime_bom_input_invalid');
  }
  return hashRecord('GpuScientificRuntimeBom', {
    version: 1,
    pde: runtimeBomComponentHashes.pde,
    deepLearning: runtimeBomComponentHashes.deepLearning,
  });
}

export function gpuScientificArtifactBodyArchiveScientificOutputCommitmentHash({
  taskSetHash,
  pdeTaskHash,
  deepLearningTaskHash,
  gpuDeviceSelector,
  runtimeImageDigest,
  runtimePackageClosureHash,
  scientificRuntimeBomHash,
  entries = [],
} = {}) {
  if (![taskSetHash, pdeTaskHash, deepLearningTaskHash, runtimeImageDigest,
    runtimePackageClosureHash].every((value) => SHA256.test(String(value || '')))
    || !GPU_UUID.test(String(gpuDeviceSelector || ''))
    || !SHA256.test(String(scientificRuntimeBomHash || ''))
    || !Array.isArray(entries)
    || entries.length
      !== GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS.length) {
    throw new Error('gpu_scientific_output_commitment_input_invalid');
  }
  const outputs = entries.map(scientificOutputEntry);
  return hashRecord('GpuScientificOutputCommitment', {
    version: 1,
    taskSetHash,
    taskHashes: {
      pde: pdeTaskHash,
      deepLearning: deepLearningTaskHash,
    },
    gpuDeviceSelector,
    runtimeImageDigest,
    runtimePackageClosureHash,
    scientificRuntimeBomHash,
    outputs,
  });
}

function entryValid(entry, specification, manifest) {
  if (!hasExactObjectKeys(entry, ENTRY_KEYS)
    || entry.taskType !== specification.taskType
    || entry.role !== specification.role
    || entry.producerRelativePath !== specification.producerRelativePath
    || entry.packageRelativePath !== specification.packageRelativePath
    || !safeRelativePath(entry.producerRelativePath)
    || !safeRelativePath(entry.packageRelativePath)
    || !entry.packageRelativePath.startsWith('evidence/gpu-scientific/')
    || !SHA256.test(String(entry.sha256 || ''))
    || !Number.isSafeInteger(entry.bytes)
    || entry.bytes < 1
    || entry.bytes > specification.maximumBytes
    || (specification.exactBytes !== null
      && entry.bytes !== specification.exactBytes)) return false;
  const lineage = expectedEntryLineage(manifest, entry.taskType);
  return Object.entries(lineage).every(([field, expected]) => (
    SHA256.test(String(entry[field] || '')) && entry[field] === expected
  ));
}

function recordPayload(record, hashField) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const { [hashField]: _claimedHash, ...payload } = record;
  return payload;
}

function uniqueStrings(values) {
  return [...new Set(values.map(String))];
}

export function buildGpuScientificArtifactBodyArchiveManifest({
  campaignId,
  paperId,
  campaignPlanHash,
  nodeId,
  attemptId,
  leaseGeneration,
  gpuScientificCampaignAttemptAuthorityHash,
  executionPlanHash,
  executionResultHash,
  taskSetHash,
  pdeTaskHash,
  deepLearningTaskHash,
  gpuDeviceSelector,
  runtimeImageDigest,
  runtimePackageClosureHash,
  runtimeEnvironmentBomHashes,
  runtimeBomComponentHashes,
  originalExecutionProcessIdentityHashes,
  pdeTaskResultHash,
  pdeScientificReceiptHash,
  pdeArtifactManifestHash,
  pdeWorkerReceiptHash,
  deepLearningTaskResultHash,
  deepLearningTrainingReceiptHash,
  deepLearningTrainingExecutionReceiptHash,
  deepLearningWorkerReceiptHash,
  entries = [],
  createdAt,
} = {}) {
  const normalizedEntries = entries.map(canonicalEntry)
    .sort((left, right) => (
      left.packageRelativePath.localeCompare(right.packageRelativePath)
    ));
  let scientificRuntimeBomHash;
  try {
    scientificRuntimeBomHash =
      gpuScientificArtifactBodyArchiveScientificRuntimeBomHash(
        runtimeBomComponentHashes,
      );
  } catch (error) {
    throw new Error(
      `gpu_scientific_artifact_body_archive_manifest_invalid:${error.message}`,
    );
  }
  let scientificOutputCommitmentHash;
  try {
    scientificOutputCommitmentHash =
      gpuScientificArtifactBodyArchiveScientificOutputCommitmentHash({
        taskSetHash: String(taskSetHash || '').toLowerCase(),
        pdeTaskHash: String(pdeTaskHash || '').toLowerCase(),
        deepLearningTaskHash: String(deepLearningTaskHash || '').toLowerCase(),
        gpuDeviceSelector: String(gpuDeviceSelector || ''),
        runtimeImageDigest: String(runtimeImageDigest || '').toLowerCase(),
        runtimePackageClosureHash:
          String(runtimePackageClosureHash || '').toLowerCase(),
        scientificRuntimeBomHash,
        entries: normalizedEntries,
      });
  } catch (error) {
    throw new Error(
      `gpu_scientific_artifact_body_archive_manifest_invalid:${error.message}`,
    );
  }
  const payload = {
    version: 2,
    kind: 'GpuScientificArtifactBodyArchiveManifest',
    status:
      'gpu_scientific_artifact_body_archive_ready_for_offline_semantic_replay',
    campaignId: String(campaignId || ''),
    paperId: String(paperId || ''),
    campaignPlanHash: String(campaignPlanHash || '').toLowerCase(),
    nodeId: String(nodeId || ''),
    attemptId: String(attemptId || ''),
    leaseGeneration: Number(leaseGeneration),
    gpuScientificCampaignAttemptAuthorityHash:
      String(gpuScientificCampaignAttemptAuthorityHash || '').toLowerCase(),
    executionPlanHash: String(executionPlanHash || '').toLowerCase(),
    executionResultHash: String(executionResultHash || '').toLowerCase(),
    taskSetHash: String(taskSetHash || '').toLowerCase(),
    pdeTaskHash: String(pdeTaskHash || '').toLowerCase(),
    deepLearningTaskHash: String(deepLearningTaskHash || '').toLowerCase(),
    gpuDeviceSelector: String(gpuDeviceSelector || ''),
    runtimeImageDigest: String(runtimeImageDigest || '').toLowerCase(),
    runtimePackageClosureHash:
      String(runtimePackageClosureHash || '').toLowerCase(),
    runtimeEnvironmentBomHashes: {
      pde: String(runtimeEnvironmentBomHashes?.pde || '').toLowerCase(),
      deepLearning:
        String(runtimeEnvironmentBomHashes?.deepLearning || '').toLowerCase(),
    },
    runtimeBomComponentHashes: {
      pde: Object.fromEntries(RUNTIME_BOM_COMPONENT_KEYS.map((field) => [
        field,
        String(runtimeBomComponentHashes?.pde?.[field] || '').toLowerCase(),
      ])),
      deepLearning: Object.fromEntries(RUNTIME_BOM_COMPONENT_KEYS.map((field) => [
        field,
        String(runtimeBomComponentHashes?.deepLearning?.[field] || '')
          .toLowerCase(),
      ])),
    },
    scientificRuntimeBomHash,
    originalExecutionProcessIdentityHashes: {
      pde: String(originalExecutionProcessIdentityHashes?.pde || '').toLowerCase(),
      deepLearning:
        String(originalExecutionProcessIdentityHashes?.deepLearning || '')
          .toLowerCase(),
    },
    pdeTaskResultHash: String(pdeTaskResultHash || '').toLowerCase(),
    pdeScientificReceiptHash: String(pdeScientificReceiptHash || '').toLowerCase(),
    pdeArtifactManifestHash: String(pdeArtifactManifestHash || '').toLowerCase(),
    pdeWorkerReceiptHash: String(pdeWorkerReceiptHash || '').toLowerCase(),
    deepLearningTaskResultHash:
      String(deepLearningTaskResultHash || '').toLowerCase(),
    deepLearningTrainingReceiptHash:
      String(deepLearningTrainingReceiptHash || '').toLowerCase(),
    deepLearningTrainingExecutionReceiptHash:
      String(deepLearningTrainingExecutionReceiptHash || '').toLowerCase(),
    deepLearningWorkerReceiptHash:
      String(deepLearningWorkerReceiptHash || '').toLowerCase(),
    bodyCount: normalizedEntries.length,
    totalBytes: normalizedEntries.reduce((total, entry) => total + entry.bytes, 0),
    entries: normalizedEntries,
    artifactBodySetHash: bodySetHash(normalizedEntries),
    scientificOutputCommitmentHash,
    archivePolicy:
      'package-contained-exact-body-set-and-semantic-replay-no-cas-fallback-v2',
    productionPromotionEligible: false,
    externalActionPerformed: false,
    createdAt: String(createdAt || ''),
  };
  const manifest = deepFreezeJsonValue({
    ...payload,
    gpuScientificArtifactBodyArchiveManifestHash:
      hashRecord('GpuScientificArtifactBodyArchiveManifest', payload),
  });
  const verification = verifyGpuScientificArtifactBodyArchiveManifest(manifest);
  if (!verification.valid) {
    throw new Error(
      `gpu_scientific_artifact_body_archive_manifest_invalid:${verification.blockers.join(',')}`,
    );
  }
  return manifest;
}

export function verifyGpuScientificArtifactBodyArchiveManifest(
  manifest,
  expected = {},
) {
  const blockers = [];
  if (!hasExactObjectKeys(manifest, MANIFEST_KEYS)
    || manifest?.version !== 2
    || manifest?.kind !== 'GpuScientificArtifactBodyArchiveManifest'
    || manifest?.status
      !== 'gpu_scientific_artifact_body_archive_ready_for_offline_semantic_replay') {
    blockers.push('gpu_scientific_artifact_body_archive_shape_invalid');
  }
  const payload = recordPayload(
    manifest,
    'gpuScientificArtifactBodyArchiveManifestHash',
  );
  if (!payload
    || !SHA256.test(String(
      manifest?.gpuScientificArtifactBodyArchiveManifestHash || '',
    ))
    || hashRecord('GpuScientificArtifactBodyArchiveManifest', payload)
      !== manifest?.gpuScientificArtifactBodyArchiveManifestHash) {
    blockers.push('gpu_scientific_artifact_body_archive_hash_invalid');
  }
  for (const field of ['campaignId', 'paperId', 'nodeId', 'attemptId']) {
    if (!SAFE_ID.test(String(manifest?.[field] || ''))) {
      blockers.push(`gpu_scientific_artifact_body_archive_${field}_invalid`);
    }
  }
  for (const field of [
    'campaignPlanHash', 'gpuScientificCampaignAttemptAuthorityHash',
    'executionPlanHash', 'executionResultHash', 'pdeTaskResultHash',
    'taskSetHash', 'pdeTaskHash', 'deepLearningTaskHash',
    'pdeScientificReceiptHash', 'pdeArtifactManifestHash',
    'pdeWorkerReceiptHash', 'deepLearningTaskResultHash',
    'deepLearningTrainingReceiptHash',
    'deepLearningTrainingExecutionReceiptHash',
    'deepLearningWorkerReceiptHash', 'artifactBodySetHash',
    'runtimeImageDigest', 'runtimePackageClosureHash',
    'scientificOutputCommitmentHash', 'scientificRuntimeBomHash',
  ]) {
    if (!SHA256.test(String(manifest?.[field] || ''))) {
      blockers.push(`gpu_scientific_artifact_body_archive_${field}_invalid`);
    }
  }
  if (!Number.isSafeInteger(manifest?.leaseGeneration)
    || manifest.leaseGeneration < 1) {
    blockers.push('gpu_scientific_artifact_body_archive_lease_invalid');
  }
  if (!GPU_UUID.test(String(manifest?.gpuDeviceSelector || ''))
    || !exactHashPair(manifest?.runtimeEnvironmentBomHashes)
    || !exactRuntimeBomComponentSet(manifest?.runtimeBomComponentHashes)
    || !exactHashPair(manifest?.originalExecutionProcessIdentityHashes)
    || manifest.originalExecutionProcessIdentityHashes?.pde
      === manifest.originalExecutionProcessIdentityHashes?.deepLearning) {
    blockers.push('gpu_scientific_artifact_body_archive_runtime_binding_invalid');
  }
  try {
    if (gpuScientificArtifactBodyArchiveScientificRuntimeBomHash(
      manifest?.runtimeBomComponentHashes,
    ) !== manifest?.scientificRuntimeBomHash) {
      blockers.push('gpu_scientific_artifact_body_archive_runtime_bom_invalid');
    }
  } catch {
    blockers.push('gpu_scientific_artifact_body_archive_runtime_bom_invalid');
  }
  const createdAtMilliseconds = Date.parse(String(manifest?.createdAt || ''));
  if (!Number.isFinite(createdAtMilliseconds)
    || new Date(createdAtMilliseconds).toISOString() !== manifest?.createdAt) {
    blockers.push('gpu_scientific_artifact_body_archive_created_at_invalid');
  }
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  if (entries.length !== GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS.length
    || manifest?.bodyCount !== entries.length
    || entries.some((entry) => {
      const specification =
        GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS.find(
          (candidate) => candidate.packageRelativePath === entry?.packageRelativePath,
        );
      return !specification || !entryValid(entry, specification, manifest);
    })
    || new Set(entries.map((entry) => entry.role)).size !== entries.length
    || new Set(entries.map((entry) => entry.packageRelativePath)).size !== entries.length
    || new Set(entries.map((entry) => (
      `${entry.taskType}\0${entry.producerRelativePath}`
    ))).size !== entries.length) {
    blockers.push('gpu_scientific_artifact_body_archive_exact_body_set_invalid');
  }
  const totalBytes = entries.reduce((total, entry) => total + Number(entry?.bytes || 0), 0);
  if (!Number.isSafeInteger(manifest?.totalBytes)
    || manifest.totalBytes !== totalBytes
    || totalBytes < 1
    || totalBytes > GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_MAXIMUM_TOTAL_BYTES) {
    blockers.push('gpu_scientific_artifact_body_archive_total_bytes_invalid');
  }
  if (bodySetHash(entries) !== manifest?.artifactBodySetHash) {
    blockers.push('gpu_scientific_artifact_body_archive_body_set_hash_invalid');
  }
  try {
    if (gpuScientificArtifactBodyArchiveScientificOutputCommitmentHash({
      taskSetHash: manifest?.taskSetHash,
      pdeTaskHash: manifest?.pdeTaskHash,
      deepLearningTaskHash: manifest?.deepLearningTaskHash,
      gpuDeviceSelector: manifest?.gpuDeviceSelector,
      runtimeImageDigest: manifest?.runtimeImageDigest,
      runtimePackageClosureHash: manifest?.runtimePackageClosureHash,
      scientificRuntimeBomHash: manifest?.scientificRuntimeBomHash,
      entries,
    }) !== manifest?.scientificOutputCommitmentHash) {
      blockers.push('gpu_scientific_artifact_body_archive_output_commitment_invalid');
    }
  } catch {
    blockers.push('gpu_scientific_artifact_body_archive_output_commitment_invalid');
  }
  if (manifest?.archivePolicy
      !== 'package-contained-exact-body-set-and-semantic-replay-no-cas-fallback-v2'
    || manifest?.productionPromotionEligible !== false
    || manifest?.externalActionPerformed !== false) {
    blockers.push('gpu_scientific_artifact_body_archive_policy_invalid');
  }
  for (const [field, value] of Object.entries(expected || {})) {
    const matches = value && typeof value === 'object'
      ? JSON.stringify(manifest?.[field]) === JSON.stringify(value)
      : manifest?.[field] === value;
    if (value !== undefined && !matches) {
      blockers.push(`gpu_scientific_artifact_body_archive_${field}_mismatch`);
    }
  }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(uniqueStrings(blockers)),
  });
}
