import {
  GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS,
} from '../../paper-domain/automation/gpu-scientific-artifact-body-archive-contract.mjs';
import {
  buildGpuScientificCampaignAttemptAuthority,
  verifyGpuScientificCampaignExecutionPlan,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import { verifyEmpiricalEnvironmentBom } from '../../paper-domain/automation/environment-bom-contract.mjs';
import { verifyWorkerProcessExecutionIdentity } from '../../paper-domain/automation/worker-process-execution-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const PDE_TASK_TYPE = 'pde-poisson-2d-gpu-v1';
const DEEP_LEARNING_TASK_TYPE = 'deep-learning-cupy-mlp-v1';

function recordHashValid(value, kind, field) {
  if (!value || !SHA256.test(String(value[field] || ''))) return false;
  const { [field]: claimedHash, ...payload } = value;
  return hashRecord(kind, payload) === claimedHash;
}

function workerReceiptHashValid(receipt) {
  if (!receipt || !SHA256.test(String(receipt.receiptHash || ''))) return false;
  const payload = { ...receipt };
  delete payload.ok;
  delete payload.receiptHash;
  delete payload.blockers;
  return hashRecord('OsSandboxWorkerReceipt', payload) === receipt.receiptHash;
}

function exactArtifactMap(workerReceipt, expectedPaths) {
  const artifacts = Array.isArray(workerReceipt?.artifacts)
    ? workerReceipt.artifacts : [];
  if (artifacts.length !== expectedPaths.length
    || workerReceipt?.artifactManifestHash
      !== hashRecord('OsSandboxWorkerArtifactManifest', artifacts)) {
    throw new Error('gpu_scientific_artifact_body_archive_worker_manifest_invalid');
  }
  const artifactMap = new Map();
  for (const artifact of artifacts) {
    if (!expectedPaths.includes(artifact?.path)
      || artifactMap.has(artifact.path)
      || !SHA256.test(String(artifact?.sha256 || ''))
      || !Number.isSafeInteger(artifact?.bytes)
      || artifact.bytes < 1) {
      throw new Error('gpu_scientific_artifact_body_archive_worker_artifacts_invalid');
    }
    artifactMap.set(artifact.path, artifact);
  }
  if (expectedPaths.some((selected) => !artifactMap.has(selected))) {
    throw new Error('gpu_scientific_artifact_body_archive_worker_artifact_set_invalid');
  }
  return artifactMap;
}

export function validateGpuScientificArtifactBodyArchiveResultAuthority({
  campaign,
  node,
  executionPlan,
  executionResult,
}) {
  if (!verifyGpuScientificCampaignExecutionPlan(executionPlan, {
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    nodeId: node?.nodeId,
  })) {
    throw new Error('gpu_scientific_artifact_body_archive_plan_invalid');
  }
  const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
    campaign,
    node,
    plan: executionPlan,
  });
  const {
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...result
  } = executionResult || {};
  if (!recordHashValid(
    result,
    'GpuScientificCampaignExecutionResult',
    'gpuScientificCampaignExecutionResultHash',
  )
    || result.status
      !== 'gpu_scientific_campaign_execution_completed_non_promotable'
    || result.campaignId !== campaign.campaignId
    || result.paperId !== campaign.paperId
    || result.campaignPlanHash !== campaign.spec.campaignPlanHash
    || result.nodeId !== node.nodeId
    || result.attemptId !== node.attemptId
    || result.leaseGeneration !== node.leaseGeneration
    || result.executionPlanHash
      !== executionPlan.gpuScientificCampaignExecutionPlanHash
    || result.gpuScientificCampaignAttemptAuthorityHash
      !== attemptAuthority.gpuScientificCampaignAttemptAuthorityHash
    || result.productionQualified !== false
    || result.promotionEligible !== false
    || result.networkActionPerformed !== false
    || result.externalActionPerformed !== false
    || !Number.isSafeInteger(result.executionCompletedAtEpochMs)
    || result.executionCompletedAtEpochMs < 0
    || !Array.isArray(result.taskResults)
    || result.taskResults.length !== 2) {
    throw new Error('gpu_scientific_artifact_body_archive_result_invalid');
  }
  const [pdeTaskResult, deepLearningTaskResult] = result.taskResults;
  for (const [index, taskResult] of result.taskResults.entries()) {
    if (!recordHashValid(
      taskResult,
      'GpuScientificCampaignTaskResult',
      'gpuScientificCampaignTaskResultHash',
    )
      || taskResult.status
        !== 'gpu_scientific_campaign_task_completed_non_promotable'
      || taskResult.taskType !== executionPlan.tasks[index].taskType
      || taskResult.taskHash
        !== executionPlan.tasks[index].gpuScientificCampaignTaskHash
      || taskResult.gpuScientificCampaignTaskResultHash
        !== result.taskResultHashes?.[index]) {
      throw new Error('gpu_scientific_artifact_body_archive_task_result_invalid');
    }
  }
  return {
    attemptAuthority,
    result,
    pdeTaskResult,
    deepLearningTaskResult,
  };
}

export function validateGpuScientificArtifactBodyArchivePdeSource(taskResult) {
  const scientificReceipt = taskResult?.receipt;
  const gpuReceipt = scientificReceipt?.gpuReceipt;
  const artifactManifest = gpuReceipt?.artifactManifest;
  const workerReceipt = artifactManifest?.osSandboxWorkerReceipt;
  if (taskResult?.taskType !== PDE_TASK_TYPE
    || taskResult.receiptHash
      !== scientificReceipt?.canonicalPdePoisson2dGpuScientificReceiptHash
    || !recordHashValid(
      scientificReceipt,
      'CanonicalPdePoisson2dGpuScientificReceipt',
      'canonicalPdePoisson2dGpuScientificReceiptHash',
    )
    || !recordHashValid(
      gpuReceipt,
      'CanonicalCupyPdePoisson2dExecutionReceipt',
      'canonicalCupyPdePoisson2dExecutionReceiptHash',
    )
    || !recordHashValid(
      artifactManifest,
      'PdePoisson2dGpuArtifactManifest',
      'pdePoisson2dGpuArtifactManifestHash',
    )
    || !workerReceiptHashValid(workerReceipt)
    || gpuReceipt.artifactManifestHash
      !== artifactManifest.pdePoisson2dGpuArtifactManifestHash
    || gpuReceipt.workerReceiptHash !== workerReceipt.receiptHash
    || artifactManifest.workerReceiptHash !== workerReceipt.receiptHash
    || artifactManifest.requestHash !== gpuReceipt.requestHash
    || !SHA256.test(String(gpuReceipt.requestHash || ''))) {
    throw new Error('gpu_scientific_artifact_body_archive_pde_receipt_invalid');
  }
  const expectedPaths = GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS
    .filter((item) => item.taskType === PDE_TASK_TYPE)
    .map((item) => item.producerRelativePath);
  const artifactMap = exactArtifactMap(workerReceipt, expectedPaths);
  const manifestArtifacts = new Map(
    (Array.isArray(artifactManifest.artifacts) ? artifactManifest.artifacts : [])
      .map((artifact) => [artifact?.relativePath, artifact]),
  );
  if (manifestArtifacts.size !== 3
    || ['solutions/n31.f64le', 'solutions/n63.f64le', 'solutions/n127.f64le']
      .some((relativePath) => {
        const declared = manifestArtifacts.get(relativePath);
        const worker = artifactMap.get(relativePath);
        return !declared || declared.sha256 !== worker.sha256
          || declared.bytes !== worker.bytes;
      })
    || artifactManifest.producerDiagnosticsHash
      !== artifactMap.get('producer-diagnostics.json').sha256) {
    throw new Error('gpu_scientific_artifact_body_archive_pde_artifact_binding_invalid');
  }
  return {
    scientificReceipt,
    gpuReceipt,
    artifactManifest,
    workerReceipt,
    artifactMap,
  };
}

export function validateGpuScientificArtifactBodyArchiveDeepLearningSource(
  taskResult,
  expectedTrainingRunId,
) {
  const receipt = taskResult?.receipt;
  const workerReceipt = receipt?.workerReceipt;
  const trainingExecutionReceipt = receipt?.trainingExecutionReceipt;
  if (taskResult?.taskType !== DEEP_LEARNING_TASK_TYPE
    || taskResult.receiptHash
      !== receipt?.canonicalCupyDeepLearningTrainingReceiptHash
    || !recordHashValid(
      receipt,
      'CanonicalCupyDeepLearningTrainingReceipt',
      'canonicalCupyDeepLearningTrainingReceiptHash',
    )
    || !workerReceiptHashValid(workerReceipt)
    || !recordHashValid(
      trainingExecutionReceipt,
      'DeepLearningTrainingExecutionReceipt',
      'deepLearningTrainingExecutionReceiptHash',
    )
    || receipt.trainingRunId !== expectedTrainingRunId
    || trainingExecutionReceipt.trainingRunId !== expectedTrainingRunId
    || receipt.workerReceiptHash !== workerReceipt.receiptHash
    || receipt.workerArtifactManifestHash !== workerReceipt.artifactManifestHash
    || receipt.trainingExecutionReceiptHash
      !== trainingExecutionReceipt.deepLearningTrainingExecutionReceiptHash) {
    throw new Error('gpu_scientific_artifact_body_archive_deep_learning_receipt_invalid');
  }
  const expectedPaths = GPU_SCIENTIFIC_ARTIFACT_BODY_ARCHIVE_ENTRY_SPECIFICATIONS
    .filter((item) => item.taskType === DEEP_LEARNING_TASK_TYPE)
    .map((item) => item.producerRelativePath);
  const artifactMap = exactArtifactMap(workerReceipt, expectedPaths);
  if (JSON.stringify(receipt.artifacts) !== JSON.stringify(workerReceipt.artifacts)
    || receipt.modelSpecificationArtifactHash
      !== artifactMap.get('model-spec.json').sha256
    || receipt.trainingPredictionsArtifactHash
      !== artifactMap.get('training-predictions.json').sha256
    || receipt.trainingSummaryArtifactHash
      !== artifactMap.get('training-summary.json').sha256
    || trainingExecutionReceipt.metricTraceArtifactHash
      !== artifactMap.get('training-trace.json').sha256
    || trainingExecutionReceipt.checkpointManifest?.checkpointArtifactHash
      !== artifactMap.get('tensor-bundle.bin').sha256
    || trainingExecutionReceipt.checkpointManifest?.tensorBundleArtifactBytes
      !== artifactMap.get('tensor-bundle.bin').bytes) {
    throw new Error(
      'gpu_scientific_artifact_body_archive_deep_learning_artifact_binding_invalid',
    );
  }
  return { receipt, workerReceipt, trainingExecutionReceipt, artifactMap };
}

export function deriveGpuScientificArtifactBodyArchiveRuntimeBindings({
  pde,
  deepLearning,
  executionPlan,
}) {
  const selected = {
    pde: pde.workerReceipt,
    deepLearning: deepLearning.workerReceipt,
  };
  for (const [role, receipt] of Object.entries(selected)) {
    const environmentVerification = verifyEmpiricalEnvironmentBom(
      receipt.environmentBom,
    );
    if (!environmentVerification.valid
      || receipt.environmentBomHash
        !== receipt.environmentBom?.environmentBomHash
      || receipt.containerImageDigest
        !== receipt.environmentBom?.runtime?.containerImageDigest
      || receipt.environmentBom?.runtime?.packageClosure?.basis
        !== 'container_image_digest'
      || receipt.environmentBom?.runtime?.packageClosure?.identityHash
        !== receipt.containerImageDigest
      || !verifyWorkerProcessExecutionIdentity(receipt, {
        requireObservedProcess: true,
      })
      || receipt.gpuDeviceRequest?.deviceSelector
        !== executionPlan.gpuDeviceSelector) {
      throw new Error(
        `gpu_scientific_artifact_body_archive_${role}_runtime_binding_invalid`,
      );
    }
  }
  const runtimeImageDigest = selected.pde.containerImageDigest;
  const runtimePackageClosureHash = selected.pde.environmentBom
    .runtime.packageClosure.identityHash;
  if (!SHA256.test(String(runtimeImageDigest || ''))
    || !SHA256.test(String(runtimePackageClosureHash || ''))
    || selected.deepLearning.containerImageDigest !== runtimeImageDigest
    || selected.deepLearning.environmentBom.runtime.packageClosure.identityHash
      !== runtimePackageClosureHash
    || selected.pde.executionProcessIdentityHash
      === selected.deepLearning.executionProcessIdentityHash) {
    throw new Error('gpu_scientific_artifact_body_archive_runtime_set_invalid');
  }
  const componentHashes = (receipt) => ({
    runtimeClosureHash: receipt.environmentBom.runtime.runtimeClosureHash,
    gpuIdentityHash: receipt.environmentBom.gpu.gpuIdentityHash,
    numericRuntimePolicyHash:
      receipt.environmentBom.numericRuntime.numericRuntimePolicyHash,
    determinismPolicyHash:
      receipt.environmentBom.determinism.determinismPolicyHash,
    buildReproducibilityHash:
      receipt.environmentBom.buildReproducibility.buildReproducibilityHash,
  });
  return {
    runtimeImageDigest,
    runtimePackageClosureHash,
    runtimeEnvironmentBomHashes: {
      pde: selected.pde.environmentBomHash,
      deepLearning: selected.deepLearning.environmentBomHash,
    },
    runtimeBomComponentHashes: {
      pde: componentHashes(selected.pde),
      deepLearning: componentHashes(selected.deepLearning),
    },
    originalExecutionProcessIdentityHashes: {
      pde: selected.pde.executionProcessIdentityHash,
      deepLearning: selected.deepLearning.executionProcessIdentityHash,
    },
  };
}
