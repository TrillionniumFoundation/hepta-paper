import fs from 'node:fs';
import path from 'node:path';
import {
  createFilesystemEmpiricalCacheRepository,
} from '../../paper-adapters/automation/empirical-cache-repository.mjs';
import {
  createMultiLanguageEmpiricalExecutor,
} from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
import {
  runtimeImagesForCampaign,
} from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import {
  directoryMerkleHash,
  fileSha256Hash,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';

export {
  composeCanonicalDeepLearningGpuTraining,
} from './deep-learning-gpu-training-composition.mjs';

export function campaignDatasetContentHash(source) {
  const resolved = path.resolve(source);
  return fs.statSync(resolved).isDirectory()
    ? directoryMerkleHash(resolved)
    : fileSha256Hash(resolved);
}

export function prepareCampaignAutomationArtifactRoot(runtimeRoot) {
  if (!runtimeRoot) throw new Error('campaign_runtime_root_required');
  const artifactRoot = path.join(path.resolve(runtimeRoot), 'automation-artifacts');
  fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const identity = fs.lstatSync(artifactRoot);
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error('campaign_automation_artifact_root_unsafe');
  }
  fs.chmodSync(artifactRoot, 0o700);
  return artifactRoot;
}

export function prepareCampaignAttemptWorkspaceRoot(runtimeRoot) {
  if (!runtimeRoot) throw new Error('campaign_runtime_root_required');
  const attemptRoot = path.join(path.resolve(runtimeRoot), 'campaign-attempt-workspaces');
  fs.mkdirSync(attemptRoot, { recursive: true, mode: 0o700 });
  const identity = fs.lstatSync(attemptRoot);
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error('campaign_attempt_workspace_root_unsafe');
  }
  fs.chmodSync(attemptRoot, 0o700);
  return attemptRoot;
}

export function buildCampaignWorkerAllowedRoots({ plans = [], runtimeRoot } = {}) {
  const campaignAttemptWorkspaceRoot = prepareCampaignAttemptWorkspaceRoot(runtimeRoot);
  return Object.freeze([...new Set([
    ...plans.map((plan) => path.resolve(plan.sourceWorkspace)),
    campaignAttemptWorkspaceRoot,
  ])]);
}

export function buildCampaignWorkerRuntimeImageConfiguration({
  requiresGpu = false,
  requireTrustedDatasetAccess = false,
} = {}) {
  const runtimeImages = runtimeImagesForCampaign({
    gpu: requiresGpu,
    requireTrustedDatasetAccess,
  });
  return Object.freeze({
    runtimeImages,
    dockerImage: runtimeImages.python?.image || null,
    allowedContainerImages: Object.freeze(
      Object.values(runtimeImages).map((item) => item.image),
    ),
    trustedDatasetSupervisorImages: Object.freeze(Object.values(runtimeImages)
      .filter((item) => item.datasetAccessSupervisor)
      .map((item) => Object.freeze({
        image: item.image,
        imageDigest: item.imageDigest,
        containerExecutable: item.executable,
        supervisor: item.datasetAccessSupervisor,
      }))),
  });
}

export function composeCampaignWorkerEmpiricalExecution({
  options = {},
  plans = [],
  runtimeRoot,
  datasetMounts = [],
  operatorDatasetAuthorityTrustStore = null,
} = {}) {
  const requiresGpu = Boolean(options.gpu) || plans.some((plan) => plan.requiresGpu);
  const automationArtifactRoot = prepareCampaignAutomationArtifactRoot(runtimeRoot);
  const allowedWorkspaceRoots = buildCampaignWorkerAllowedRoots({ plans, runtimeRoot });
  const {
    runtimeImages,
    dockerImage,
    allowedContainerImages,
    trustedDatasetSupervisorImages,
  } = buildCampaignWorkerRuntimeImageConfiguration({
    requiresGpu,
    requireTrustedDatasetAccess: datasetMounts.length > 0,
  });
  const workerRunner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3', process.execPath, 'Rscript', 'julia', 'lake', 'latexmk'],
    allowedRoots: allowedWorkspaceRoots,
    allowedOutputRoots: [automationArtifactRoot],
    allowedDatasetRoots: datasetMounts.map((mount) => mount.source),
    allowedContainerImages,
    dockerImage,
    trustedDatasetSupervisorImages,
    allowGpu: requiresGpu,
    maximumTimeoutMs: Number(options['max-wall-ms'] || 6 * 60 * 60 * 1000),
    maximumMemoryBytes: Number(options['worker-memory-mib'] || 4096) * 1024 * 1024,
    maximumCpuSeconds: Number(options['worker-cpu-seconds'] || 3600),
  });
  const empiricalExecutor = createMultiLanguageEmpiricalExecutor({
    workerRunner,
    runtimeImages,
    cache: createFilesystemEmpiricalCacheRepository({
      root: path.join(runtimeRoot, 'automation-cache', 'empirical'),
    }),
    operatorDatasetAuthorityTrustStore,
    runtimeRoot,
  });
  return Object.freeze({
    empiricalExecutor,
    workerRunner,
    runtimeImages,
    allowedWorkspaceRoots,
  });
}
