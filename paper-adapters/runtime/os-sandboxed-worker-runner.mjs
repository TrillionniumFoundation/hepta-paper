import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertWorkerRunnerPort } from '../../paper-ports/worker-runner-port.mjs';
import { buildExecutorCapabilities, evaluateExecutorCapabilityRequest } from '../../paper-ports/executor-capabilities.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { inspectScopedPathSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import { runBoundedChildProcess } from '../automation/bounded-child-process.mjs';
import { inspectDockerImageDigest, normalizeContainerImageDigest, probeDockerDaemon, probeOsSandbox, probeProcessLimit, resolveExecutable, resolveExecutableInvocationPath } from './sandbox-backend-probe.mjs'; export { probeOsSandbox } from './sandbox-backend-probe.mjs';
import { fileSha256Hash, inspectStrictDatasetManifest, inspectWorkspaceExecutionSnapshot, mapWorkArgument, materializeDatasetSnapshot, materializeRuntimeExecutableSnapshot, safeStrictDatasetManifestHash, sourceTreeExcludedNames } from './execution-snapshot.mjs'; export { directoryMerkleHash, fileSha256Hash, inspectWorkspaceExecutionSnapshot, sourceTreeExcludedNames } from './execution-snapshot.mjs';
import {
  abortStagedScopedFileSync,
  commitStagedScopedFileSync,
  inspectScopedRegularFileSync,
  inspectScopedRegularFileWithRecoverySync,
  stageScopedRegularFileCopySync,
} from './scoped-file-materialization-repository.mjs';
import { buildDatasetRuntimeAccessReceipt, buildRuntimeDatasetAuthorizationSet, DATASET_ACCESS_SUPERVISOR_TRACER } from './dataset-runtime-access-receipt.mjs';
import { selectAndValidateWorkerEnvironment } from './worker-environment-policy.mjs';
import { createWorkerEnvironmentBomPreparer } from './worker-environment-bom-binding.mjs';
import { beginWorkerProcessIdentity, bubblewrapRuntimeResourceMounts, buildBubblewrapWorkerCommand, buildDockerWorkerCommand, completeWorkerProcessIdentity, createDatasetSupervisorEvidenceFiles, datasetRuntimePreflightBlockers, dockerSystemMounts, executableRuntimePathSupported, explicitContainerRuntimeIdentityPayload, normalizeTrustedDatasetSupervisorImage, prepareUnprivilegedDatasetWorkspace } from './os-sandbox-worker-runtime-support.mjs';

function removePrivateSandboxRoot(sandboxRoot) {
  const candidate = path.resolve(String(sandboxRoot || ''));
  const temporaryRoot = path.resolve(os.tmpdir());
  if (!isPathWithin(temporaryRoot, candidate)
    || !path.basename(candidate).startsWith('hepta-os-sandbox-')) {
    throw new Error('os_sandbox_cleanup_root_invalid');
  }
  const restoreDirectoryWrite = (directory) => {
    let identity = null;
    try { identity = fs.lstatSync(directory); } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) return;
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory)) {
      const child = path.join(directory, entry);
      const childIdentity = fs.lstatSync(child);
      if (childIdentity.isDirectory() && !childIdentity.isSymbolicLink()) {
        restoreDirectoryWrite(child);
      }
    }
  };
  restoreDirectoryWrite(candidate);
  fs.rmSync(candidate, { recursive: true, force: true });
}

export function createOsSandboxedWorkerRunner({
  allowedExecutables = [], allowedRoots = [], allowedOutputRoots = [], allowGpu = false, bubblewrap = 'bwrap', prlimit = 'prlimit', docker = 'docker', dockerImage = null,
  allowedContainerImages = [], allowedDatasetRoots = [], trustedDatasetSupervisorImages = [],
  maximumTimeoutMs = 120000, maximumMemoryBytes = 1024 * 1024 * 1024, maximumCpuSeconds = 120, maximumPids = 128, maximumOutputBytes = 256 * 1024 * 1024, maximumCapturedBytes = 4 * 1024 * 1024,
  executor = spawnSync, probe = null, imageDigestResolver = null, datasetSnapshotObserver = null, runtimeExecutableSnapshotObserver = null, workspaceSnapshotObserver = null,
} = {}) {
  const allowedExecutableEntries = allowedExecutables.map((value) => Object.freeze({
    requested: String(value),
    invocationPath: resolveExecutableInvocationPath(value),
    resolvedExecutable: resolveExecutable(value),
  }));
  const resolveAllowedExecutable = (executable) => {
    const requested = String(executable || '');
    const invocationPath = resolveExecutableInvocationPath(executable);
    const resolvedExecutable = resolveExecutable(executable);
    const entry = allowedExecutableEntries.find((candidate) => candidate.requested === requested
      && candidate.invocationPath === invocationPath
      && candidate.resolvedExecutable === resolvedExecutable) || null;
    return Object.freeze({ requested, invocationPath, resolvedExecutable, entry, allowlisted: Boolean(entry && invocationPath && resolvedExecutable) });
  };
  const roots = allowedRoots.map((root) => path.resolve(root));
  const outputRoots = allowedOutputRoots.map((root) => path.resolve(root));
  const datasetRoots = allowedDatasetRoots.map((root) => path.resolve(root));
  const containerImages = new Set(allowedContainerImages.map(String));
  const trustedDatasetSupervisors = new Map(trustedDatasetSupervisorImages
    .map(normalizeTrustedDatasetSupervisorImage)
    .filter(Boolean)
    .map((entry) => [entry.image, entry]));
  const issuedExecutionIdentities = new WeakMap();
  const resolveImageDigest = imageDigestResolver || ((image) => inspectDockerImageDigest(docker, image));
  const trustedDatasetSupervisorProfiles = [...trustedDatasetSupervisors.values()];
  const availability = probe || probeOsSandbox({ bubblewrap, prlimit, docker, dockerImage, trustedDatasetSupervisorImages: trustedDatasetSupervisorProfiles });
  const backend = availability.backend || 'bubblewrap';
  const advertisedProcessLimit = backend === 'docker'
    ? Object.freeze({ available: true, mechanism: 'docker-pids-cgroup' })
    : (availability.processLimit || probeProcessLimit(prlimit));
  const runnerId = `${backend}-kernel-isolation-worker-v4`;
  const issueExecutionIdentity = (payload) => {
    const identity = Object.freeze({ ...payload, runtimeIdentityHash: hashRecord('WorkerExecutionRuntimeIdentity', payload) });
    issuedExecutionIdentities.set(identity, { identity, consumed: false });
    return identity;
  };
  const resolveExecutionRuntimeIdentity = ({ executable, containerImage = null, containerExecutable = null } = {}) => {
    const allowedExecutable = resolveAllowedExecutable(executable);
    const resolvedExecutable = allowedExecutable.resolvedExecutable;
    const executableInvocationPath = allowedExecutable.invocationPath;
    const executableInvocationName = path.basename(String(executable || ''));
    const executableAllowlisted = allowedExecutable.allowlisted;
    if (containerImage) {
      const requestedImage = String(containerImage);
      const digest = normalizeContainerImageDigest(requestedImage) || normalizeContainerImageDigest(resolveImageDigest(requestedImage));
      return issueExecutionIdentity(explicitContainerRuntimeIdentityPayload({
        requestedImage, digest, containerExecutable, runnerId,
        allowedImages: containerImages,
        trustedDatasetSupervisors,
      }));
    }
    if (backend === 'docker') {
      const probedDigest = availability.image === dockerImage
        ? normalizeContainerImageDigest(availability.imageDigest)
        : null;
      const digest = probedDigest || normalizeContainerImageDigest(dockerImage) || normalizeContainerImageDigest(resolveImageDigest(dockerImage));
      let executableHash = null;
      try { executableHash = resolvedExecutable ? sha256FileSync(resolvedExecutable) : null; } catch { executableHash = null; }
      return issueExecutionIdentity({
        version: 1,
        kind: 'WorkerExecutionRuntimeIdentity',
        runtimeType: 'container',
        executionClass: 'hybrid-docker',
        runnerId,
        backend: 'docker',
        requestedImage: dockerImage,
        digest,
        containerExecutable: null,
        hostExecutable: resolvedExecutable,
        hostExecutableHash: executableHash,
        executableInvocationPath,
        executableInvocationName,
        available: Boolean(digest && executableHash),
        allowlisted: executableAllowlisted,
        cacheable: false,
        hybridHostRuntime: true,
      });
    }
    let executableHash = null;
    try { executableHash = resolvedExecutable ? sha256FileSync(resolvedExecutable) : null; } catch { executableHash = null; }
    const payload = {
      version: 1,
      kind: 'HostRuntimeIdentity',
      runtimeType: 'host',
      executionClass: 'host',
      runnerId,
      backend,
      executable: String(executable || ''),
      executableInvocationPath,
      executableInvocationName,
      resolvedExecutable,
      executableHash,
      available: Boolean(executableHash),
      allowlisted: executableAllowlisted,
    };
    return issueExecutionIdentity({ ...payload, cacheable: false });
  };
  const capabilities = buildExecutorCapabilities({
    executorId: runnerId,
    sandboxModes: ['kernel-isolated'],
    networkPolicy: 'none',
    workspaceIsolation: true,
    languages: ['*'],
    gpu: allowGpu,
    maximumTimeoutMs,
    receiptKinds: ['OsSandboxWorkerReceipt'],
    provider: backend,
  });
  const prepareEnvironmentBom = createWorkerEnvironmentBomPreparer({ maximumTimeoutMs, maximumMemoryBytes, maximumCpuSeconds, maximumPids, maximumOutputBytes, maximumCapturedBytes });
  return assertWorkerRunnerPort({
    version: 4,
    kind: 'OsSandboxedWorkerRunner',
    runnerId,
    capabilities: () => capabilities,
    resolveExecutionRuntimeIdentity,
    prepareEnvironmentBom,
    availability,
    isolation: Object.freeze({ backend, sourceReadOnly: true, ephemeralWorkRoot: true, separateOutputRoot: true, hostEtcMounted: false, userNamespace: backend === 'bubblewrap', mountNamespace: true, pidNamespace: true, networkNamespace: true, readOnlyRuntime: true, memoryLimit: true, cpuLimit: true, processLimit: advertisedProcessLimit.available, processLimitMechanism: advertisedProcessLimit.mechanism }),
    run(spec = {}) {
      const removedInputs = ['containerImageIdentity', 'containerImageDigest']
        .filter((name) => Object.prototype.hasOwnProperty.call(spec, name));
      if (removedInputs.length) {
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: removedInputs.map((name) => `worker_run_input_removed:${name}`),
          availability,
          isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false },
        };
      }
      const { executable, args = [], cwd, sourceRoot = null, timeoutMs = 30000, outputPaths = [], outputDirectory = null, requiresGpu = false, env = {}, executionIdentity: suppliedExecutionIdentity = null, containerImage = null, containerExecutable = null, datasetMounts = [], requireDatasetAccessProof = false, requireSeparateOutputRoot = false, requireImmutableWorkRoot = false, memoryBytes = null, cpuSeconds = null, maximumProcesses = null, requestedMaximumOutputBytes = null, language = 'unknown', determinismPolicy = 'unknown', deterministicSeed = null, runtimePackageClosure = null, runtimeBuildReproducibility = null, expectedSourceMerkleHash = null, expectedSourceWorkspaceManifestHash = null, signal = null } = spec;
      const capabilityPreflight = evaluateExecutorCapabilityRequest({
        capabilities,
        request: { sandbox: 'kernel-isolated', requiresGpu, requiresWorkspaceIsolation: true, requiresNetworkIsolation: true, timeoutMs },
      });
      if (capabilityPreflight.blockers.length) return { ok: false, status: 'os_sandbox_worker_blocked', blockers: capabilityPreflight.blockers, availability, isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false } };
      const selectedImage = containerImage ? String(containerImage) : dockerImage;
      const executionAvailability = containerImage
        ? (availability.available && availability.backend === 'docker'
          ? availability
          : probeDockerDaemon({ docker, image: selectedImage }))
        : (availability.available ? availability : probeOsSandbox({ bubblewrap, prlimit, docker, dockerImage, trustedDatasetSupervisorImages: trustedDatasetSupervisorProfiles, refresh: true }));
      const executionBackend = containerImage ? 'docker' : (executionAvailability.backend || backend);
      const presentedExecutionIdentity = suppliedExecutionIdentity || null;
      const issuedExecutionRecord = presentedExecutionIdentity && typeof presentedExecutionIdentity === 'object'
        ? issuedExecutionIdentities.get(presentedExecutionIdentity) || null
        : null;
      const issuedExecutionIdentity = issuedExecutionRecord?.identity || null;
      const issuedExecutionIdentityAlreadyConsumed = Boolean(issuedExecutionRecord?.consumed);
      if (issuedExecutionRecord && !issuedExecutionRecord.consumed) issuedExecutionRecord.consumed = true;
      const internallyResolvedExecutionIdentity = presentedExecutionIdentity
        ? null
        : resolveExecutionRuntimeIdentity({ executable, containerImage, containerExecutable });
      const activeExecutionIdentity = issuedExecutionIdentity || internallyResolvedExecutionIdentity;
      const expectedExecutionClass = containerImage ? 'explicit-container' : executionBackend === 'docker' ? 'hybrid-docker' : 'host';
      const imageIdentity = activeExecutionIdentity?.runtimeType === 'container'
        ? activeExecutionIdentity
        : Object.freeze({ requestedImage: selectedImage, digest: null, available: executionBackend !== 'docker', allowlisted: executionBackend !== 'docker' });
      const processLimitProbe = executionBackend === 'bubblewrap' ? probeProcessLimit(prlimit) : Object.freeze({ available: true, mechanism: 'docker-pids-cgroup', executable: docker, detail: 'docker_pids_limit_available' });
      const containerImageDigest = executionBackend === 'docker' ? imageIdentity.digest : null;
      const allowedExecutable = resolveAllowedExecutable(executable);
      const resolvedExecutable = allowedExecutable.resolvedExecutable;
      const executableInvocationPath = allowedExecutable.invocationPath;
      const executableInvocationName = path.basename(String(executable || ''));
      let resolvedExecutableHash = null;
      try { resolvedExecutableHash = resolvedExecutable ? sha256FileSync(resolvedExecutable) : null; } catch { resolvedExecutableHash = null; }
      const resolvedCwd = path.resolve(cwd || '.');
      const allowedRoot = roots.find((root) => isPathWithin(root, resolvedCwd));
      const resolvedSourceRoot = path.resolve(sourceRoot || allowedRoot || resolvedCwd);
      const blockers = [];
      if (!executionAvailability.available) blockers.push('os_sandbox_runtime_unavailable');
      if (!processLimitProbe.available) blockers.push('os_sandbox_process_limit_unavailable');
      if (presentedExecutionIdentity && !issuedExecutionIdentity) blockers.push('worker_execution_identity_capability_invalid');
      if (issuedExecutionIdentityAlreadyConsumed) blockers.push('worker_execution_identity_capability_consumed');
      if (activeExecutionIdentity && activeExecutionIdentity.executionClass !== expectedExecutionClass) blockers.push('worker_execution_identity_class_mismatch');
      if (activeExecutionIdentity && activeExecutionIdentity.backend !== executionBackend) blockers.push('worker_execution_identity_backend_mismatch');
      if (expectedExecutionClass === 'explicit-container' && activeExecutionIdentity?.requestedImage !== selectedImage) blockers.push('worker_container_image_identity_image_mismatch');
      if (expectedExecutionClass === 'explicit-container' && activeExecutionIdentity?.containerExecutable !== String(containerExecutable || '')) blockers.push('worker_container_executable_identity_mismatch');
      if (expectedExecutionClass === 'hybrid-docker' && (activeExecutionIdentity?.hostExecutable !== resolvedExecutable || activeExecutionIdentity?.hostExecutableHash !== resolvedExecutableHash || activeExecutionIdentity?.executableInvocationPath !== executableInvocationPath || activeExecutionIdentity?.executableInvocationName !== executableInvocationName)) blockers.push('worker_hybrid_executable_identity_mismatch');
      if (expectedExecutionClass === 'host' && (activeExecutionIdentity?.executable !== String(executable || '') || activeExecutionIdentity?.executableInvocationPath !== executableInvocationPath || activeExecutionIdentity?.executableInvocationName !== executableInvocationName || activeExecutionIdentity?.resolvedExecutable !== resolvedExecutable || activeExecutionIdentity?.executableHash !== resolvedExecutableHash)) blockers.push('worker_host_executable_identity_mismatch');
      if (executionBackend === 'docker' && !/^sha256:[0-9a-f]{64}$/i.test(String(containerImageDigest || ''))) blockers.push('worker_container_image_digest_unavailable');
      if (containerImage) {
        if (!imageIdentity.allowlisted) blockers.push('worker_container_image_not_allowlisted');
        if (!containerExecutable || path.isAbsolute(String(containerExecutable))) blockers.push('worker_container_executable_invalid');
      } else if (!allowedExecutable.allowlisted) blockers.push('worker_executable_not_allowlisted');
      if (!allowedRoot) blockers.push('worker_cwd_outside_allowed_roots');
      if (!allowedRoot || !isPathWithin(allowedRoot, resolvedSourceRoot) || !isPathWithin(resolvedSourceRoot, resolvedCwd)) blockers.push('worker_source_root_invalid');
      if (expectedExecutionClass !== 'explicit-container'
        && (!executableRuntimePathSupported(resolvedExecutable, resolvedSourceRoot) || !executableRuntimePathSupported(executableInvocationPath, resolvedSourceRoot))) {
        blockers.push('worker_runtime_executable_support_root_unavailable');
      }
      if (allowedRoot) {
        const sourceIdentity = inspectScopedPathSync({ scopeRoot: allowedRoot, candidate: resolvedSourceRoot, expect: 'directory', forbidHardlinks: false });
        const cwdIdentity = inspectScopedPathSync({ scopeRoot: allowedRoot, candidate: resolvedCwd, expect: 'directory', forbidHardlinks: false });
        if (sourceIdentity.blockers.length || cwdIdentity.blockers.length) blockers.push('worker_workspace_path_unsafe');
      }
      if (outputPaths.some((candidate) => path.isAbsolute(String(candidate)) || String(candidate).split(/[\\/]+/).includes('..'))) blockers.push('worker_output_path_not_relative');
      const resolvedOutputDirectory = outputDirectory ? path.resolve(outputDirectory) : null;
      const allowedOutputRoot = resolvedOutputDirectory ? outputRoots.find((root) => isPathWithin(root, resolvedOutputDirectory)) : null;
      if (outputPaths.length && (!resolvedOutputDirectory || !allowedOutputRoot)) blockers.push('worker_output_directory_not_allowlisted');
      const gpuDevices = fs.existsSync('/dev') ? fs.readdirSync('/dev').filter((name) => /^nvidia(?:\d+|ctl|uvm|uvm-tools|modeset)$/.test(name)).map((name) => `/dev/${name}`) : [];
      if (requiresGpu && (!allowGpu || gpuDevices.length === 0)) blockers.push('worker_gpu_not_available_or_not_allowed');
      const normalizedDatasets = datasetMounts.map((mount, index) => {
        const source = path.resolve(String(mount?.source || ''));
        const name = String(mount?.name || `dataset-${index + 1}`).replace(/[^A-Za-z0-9_.-]/g, '_');
        const allowedDatasetRoot = datasetRoots.find((root) => isPathWithin(root, source)) || null;
        let sourceType = null;
        let boundaryBlockers = [];
        let manifestInspection = null;
        if (allowedDatasetRoot) {
          try {
            const stat = fs.lstatSync(source);
            sourceType = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : null;
            const identity = inspectScopedPathSync({ scopeRoot: allowedDatasetRoot, candidate: source, expect: sourceType || 'file', forbidHardlinks: sourceType === 'file' });
            boundaryBlockers = identity.blockers;
            if (!boundaryBlockers.length && sourceType) {
              manifestInspection = inspectStrictDatasetManifest(source, allowedDatasetRoot);
              boundaryBlockers = [...boundaryBlockers, ...manifestInspection.blockers];
            }
          } catch (error) {
            boundaryBlockers = [error?.code || 'dataset_source_unreadable'];
          }
        }
        return { source, target: `/datasets/${name}`, name, readOnly: mount?.readOnly === true,
          manifestHash: mount?.manifestHash || null, manifestHashBefore: manifestInspection?.hash || null, manifestEntries: manifestInspection?.entries || [], licenseId: mount?.licenseId || null,
          operatorAuthorizationHash: mount?.operatorAuthorizationHash || null, operatorDatasetAuthorityDocumentHash: mount?.operatorDatasetAuthorityDocumentHash || null, operatorDatasetAuthority: mount?.operatorDatasetAuthority || null,
          splitManifestHash: mount?.splitManifestHash || null, benchmarkHarnessDocumentHash: mount?.benchmarkHarnessDocumentHash || null, benchmarkHarnessDefinitionHash: mount?.benchmarkHarnessDefinitionHash || null,
          benchmarkFamily: mount?.benchmarkFamily || null, benchmarkSeedSchedule: Array.isArray(mount?.benchmarkSeedSchedule) ? mount.benchmarkSeedSchedule.map(Number) : [], benchmarkMinimumRepetitions: Number(mount?.benchmarkMinimumRepetitions || 0), analysisProtocol: mount?.analysisProtocol || null, analysisProtocolHash: mount?.analysisProtocolHash || null,
          allowedDatasetRoot, sourceType, boundaryBlockers };
      });
      const datasetAuthorizationSet = buildRuntimeDatasetAuthorizationSet(normalizedDatasets);
      blockers.push(...datasetRuntimePreflightBlockers({
        datasets: normalizedDatasets, environment: env,
        authorizationSetHash: datasetAuthorizationSet.datasetAuthorizationSetHash,
        requireProof: requireDatasetAccessProof, executionBackend, executionClass: expectedExecutionClass,
        executionIdentity: activeExecutionIdentity, containerImageDigest,
        hostTracerAvailable: fs.existsSync(DATASET_ACCESS_SUPERVISOR_TRACER),
      }));
      if (expectedSourceMerkleHash !== null && expectedSourceMerkleHash !== undefined && !/^sha256:[0-9a-f]{64}$/i.test(String(expectedSourceMerkleHash))) blockers.push('worker_expected_source_merkle_hash_invalid');
      if (expectedSourceWorkspaceManifestHash !== null && expectedSourceWorkspaceManifestHash !== undefined && !/^sha256:[0-9a-f]{64}$/i.test(String(expectedSourceWorkspaceManifestHash))) blockers.push('worker_expected_source_workspace_manifest_hash_invalid');
      if (blockers.length) return { ok: false, status: 'os_sandbox_worker_blocked', blockers, availability: executionAvailability, isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false } };
      const sourceDatasetRoots = normalizedDatasets.map((mount) => mount.source).filter((source) => source !== resolvedSourceRoot && isPathWithin(resolvedSourceRoot, source));
      const sourceExcludedNames = sourceTreeExcludedNames(resolvedSourceRoot);
      const sourceExecutionSnapshotBefore = inspectWorkspaceExecutionSnapshot(resolvedSourceRoot, { excludeRoots: sourceDatasetRoots, excludeNames: sourceExcludedNames });
      const sourceMerkleHashBefore = sourceExecutionSnapshotBefore.merkleHash;
      const sourceWorkspaceManifestHashBefore = sourceExecutionSnapshotBefore.manifestHash;
      if (sourceExecutionSnapshotBefore.blockers.length) {
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: ['worker_workspace_execution_snapshot_unsafe', ...sourceExecutionSnapshotBefore.blockers],
          availability: executionAvailability,
          isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false, workspaceExecutionSnapshotVerified: false },
        };
      }
      if (expectedSourceMerkleHash && sourceMerkleHashBefore !== String(expectedSourceMerkleHash).toLowerCase()) {
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: ['worker_expected_source_merkle_hash_mismatch'],
          expectedSourceMerkleHash: String(expectedSourceMerkleHash).toLowerCase(),
          sourceMerkleHashBefore,
          availability: executionAvailability,
          isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false, workspaceExecutionSnapshotVerified: false },
        };
      }
      if (expectedSourceWorkspaceManifestHash && sourceWorkspaceManifestHashBefore !== String(expectedSourceWorkspaceManifestHash).toLowerCase()) {
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: ['worker_expected_source_workspace_manifest_hash_mismatch'],
          expectedSourceWorkspaceManifestHash: String(expectedSourceWorkspaceManifestHash).toLowerCase(),
          sourceWorkspaceManifestHashBefore,
          availability: executionAvailability,
          isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false, workspaceExecutionSnapshotVerified: false },
        };
      }
      const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-os-sandbox-'));
      const workRoot = path.join(sandboxRoot, 'work');
      const outputRoot = path.join(sandboxRoot, 'output');
      const supervisorRoot = path.join(sandboxRoot, 'supervisor');
      const datasetAccessTracePath = path.join(supervisorRoot, 'dataset-access.trace');
      const datasetAccessSupervisorIdentityPath = path.join(supervisorRoot, 'supervisor-identity');
      fs.mkdirSync(supervisorRoot, { mode: 0o700 });
      fs.chmodSync(supervisorRoot, 0o700);
      if (requireDatasetAccessProof && executionBackend === 'docker') {
        createDatasetSupervisorEvidenceFiles({ tracePath: datasetAccessTracePath, identityPath: datasetAccessSupervisorIdentityPath });
      }
      let runtimeExecutableSnapshot = null;
      if (expectedExecutionClass !== 'explicit-container') {
        const expectedExecutablePath = expectedExecutionClass === 'hybrid-docker'
          ? activeExecutionIdentity.hostExecutable
          : activeExecutionIdentity.resolvedExecutable;
        const expectedExecutableHash = expectedExecutionClass === 'hybrid-docker'
          ? activeExecutionIdentity.hostExecutableHash
          : activeExecutionIdentity.executableHash;
        try {
          runtimeExecutableSnapshot = materializeRuntimeExecutableSnapshot({ source: expectedExecutablePath, expectedHash: expectedExecutableHash, invocationName: activeExecutionIdentity.executableInvocationName, sandboxRoot });
        } catch (error) {
          removePrivateSandboxRoot(sandboxRoot);
          return {
            ok: false,
            status: 'os_sandbox_worker_blocked',
            blockers: ['worker_runtime_executable_snapshot_failed', error?.code || 'runtime_executable_snapshot_failed'],
            availability: executionAvailability,
            isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false, runtimeExecutableSnapshotVerified: false },
          };
        }
      }
      runtimeExecutableSnapshotObserver?.(Object.freeze({
        phase: 'after_runtime_executable_snapshot',
        source: resolvedExecutable,
        snapshotHash: runtimeExecutableSnapshot?.hash || null,
        executionClass: expectedExecutionClass,
      }));
      let mountedDatasets = [];
      try {
        datasetSnapshotObserver?.(Object.freeze({ phase: 'before_dataset_snapshot', datasets: Object.freeze(normalizedDatasets.map((mount) => Object.freeze({ name: mount.name, source: mount.source, manifestHashBefore: mount.manifestHashBefore }))) }));
        mountedDatasets = normalizedDatasets.map((mount) => materializeDatasetSnapshot(mount, sandboxRoot));
      } catch (error) {
        removePrivateSandboxRoot(sandboxRoot);
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: ['worker_dataset_snapshot_materialization_failed', error?.code || 'dataset_snapshot_failed'],
          availability: executionAvailability,
          isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false, datasetSnapshotsVerified: false },
        };
      }
      const invalidSnapshots = mountedDatasets.filter((mount) => mount.snapshotBlockers.length || mount.snapshotManifestHash !== mount.manifestHashBefore || mount.snapshotManifestHash !== mount.manifestHash);
      if (invalidSnapshots.length) {
        const failedDatasetNames = invalidSnapshots.map((mount) => mount.name);
        removePrivateSandboxRoot(sandboxRoot);
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: ['worker_dataset_snapshot_manifest_mismatch', ...failedDatasetNames.map((name) => `worker_dataset_snapshot_invalid:${name}`)],
          availability: executionAvailability,
          isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false, datasetSnapshotsVerified: false },
        };
      }
      try {
        workspaceSnapshotObserver?.(Object.freeze({ phase: 'before_workspace_copy', sourceRoot: resolvedSourceRoot, workRoot, sourceMerkleHashBefore, sourceWorkspaceManifestHashBefore }));
        fs.cpSync(resolvedSourceRoot, workRoot, {
          recursive: true,
          dereference: false,
          filter: (candidate) => {
            if (path.resolve(candidate) === resolvedSourceRoot) return true;
            if (sourceDatasetRoots.some((blocked) => isPathWithin(blocked, candidate))) return false;
            return !sourceExcludedNames.includes(path.basename(candidate));
          },
        });
        workspaceSnapshotObserver?.(Object.freeze({ phase: 'after_workspace_copy', sourceRoot: resolvedSourceRoot, workRoot, sourceMerkleHashBefore, sourceWorkspaceManifestHashBefore }));
      } catch (error) {
        removePrivateSandboxRoot(sandboxRoot);
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: ['worker_workspace_snapshot_copy_failed', error?.code || 'workspace_copy_failed'],
          availability: executionAvailability,
          isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false, workspaceExecutionSnapshotVerified: false },
        };
      }
      const workDatasetRoots = sourceDatasetRoots.map((source) => path.join(workRoot, path.relative(resolvedSourceRoot, source)));
      const workExecutionSnapshot = inspectWorkspaceExecutionSnapshot(workRoot, { excludeRoots: workDatasetRoots, excludeNames: sourceExcludedNames });
      const workSourceMerkleHash = workExecutionSnapshot.merkleHash;
      const workWorkspaceManifestHash = workExecutionSnapshot.manifestHash;
      const workspaceSnapshotBlockers = [
        ...workExecutionSnapshot.blockers,
        ...(workSourceMerkleHash !== sourceMerkleHashBefore || workWorkspaceManifestHash !== sourceWorkspaceManifestHashBefore ? ['worker_workspace_execution_snapshot_mismatch'] : []),
      ];
      if (runtimeExecutableSnapshot && isPathWithin(resolvedSourceRoot, resolvedExecutable)) {
        const workExecutable = path.join(workRoot, path.relative(resolvedSourceRoot, resolvedExecutable));
        let workExecutableHash = null;
        try { workExecutableHash = fileSha256Hash(workExecutable); } catch { workExecutableHash = null; }
        if (workExecutableHash !== runtimeExecutableSnapshot.hash) workspaceSnapshotBlockers.push('worker_workspace_executable_snapshot_mismatch');
      }
      if (workspaceSnapshotBlockers.length) {
        removePrivateSandboxRoot(sandboxRoot);
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: [...new Set(workspaceSnapshotBlockers)],
          sourceMerkleHashBefore,
          sourceWorkspaceManifestHashBefore,
          workSourceMerkleHash,
          workWorkspaceManifestHash,
          availability: executionAvailability,
          isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false, workspaceExecutionSnapshotVerified: false },
        };
      }
      fs.mkdirSync(outputRoot, { recursive: true });
      if (requireDatasetAccessProof && executionBackend === 'docker') {
        prepareUnprivilegedDatasetWorkspace({ outputRoot, workRoot, mountedDatasets });
      }
      const relativeCwd = path.relative(resolvedSourceRoot, resolvedCwd);
      const runtimeExecutableOverlayTarget = runtimeExecutableSnapshot
        ? (isPathWithin(resolvedSourceRoot, resolvedExecutable) ? `/work${resolvedExecutable.slice(resolvedSourceRoot.length)}` : resolvedExecutable)
        : resolvedExecutable;
      const runtimeExecutableInvocationTarget = runtimeExecutableSnapshot
        ? (isPathWithin(resolvedSourceRoot, activeExecutionIdentity.executableInvocationPath)
          ? `/work${activeExecutionIdentity.executableInvocationPath.slice(resolvedSourceRoot.length)}`
          : activeExecutionIdentity.executableInvocationPath)
        : resolvedExecutable;
      const processInvocationId = beginWorkerProcessIdentity();
      const { permittedEnvironment, environmentBindingHash, blockers: environmentBlockers } = selectAndValidateWorkerEnvironment({
        env,
        datasetAuthorizationSetHash: datasetAuthorizationSet.datasetAuthorizationSetHash,
      });
      if (environmentBlockers.length) {
        removePrivateSandboxRoot(sandboxRoot);
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: [...environmentBlockers],
          availability: executionAvailability,
          isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false },
        };
      }
      const environmentBomBinding = prepareEnvironmentBom({ executionIdentity: activeExecutionIdentity, language, executable: containerImage ? containerExecutable : resolvedExecutable, requiresGpu, determinismPolicy, deterministicSeed: deterministicSeed ?? env.HEPTA_EXPERIMENT_SEED ?? env.HEPTA_SEED ?? env.PYTHONHASHSEED ?? null, timeoutMs, memoryBytes, cpuSeconds, maximumProcesses, requestedMaximumOutputBytes, env: Object.fromEntries(permittedEnvironment), runtimePackageClosure, runtimeBuildReproducibility });
      if (environmentBomBinding.blockers.length) { removePrivateSandboxRoot(sandboxRoot); return { ok: false, status: 'os_sandbox_worker_blocked', blockers: environmentBomBinding.blockers, availability: executionAvailability, isolation: { kernelNetworkIsolationVerified: false, filesystemNamespaceVerified: false, sourceReadOnlyVerified: false, resourceLimitsVerified: false } }; }
      const { timeoutMs: boundedTimeout, memoryBytes: boundedMemory, cpuSeconds: boundedCpu, maximumPids: boundedPids, maximumOutputBytes: boundedOutput } = environmentBomBinding.limits;
      let launcher = prlimit;
      let command = buildBubblewrapWorkerCommand({
        limits: { memory: boundedMemory, cpu: boundedCpu, pids: boundedPids }, bubblewrap,
        texMounts: ['/var/lib/texmf', '/etc/texmf'].filter((candidate) => fs.existsSync(candidate)).flatMap((candidate) => ['--ro-bind', candidate, candidate]),
        runtimeMounts: bubblewrapRuntimeResourceMounts(resolvedExecutable), workRoot, outputRoot,
        runtimeExecutableSnapshot, runtimeExecutableOverlayTarget, relativeCwd, mountedDatasets,
        requiresGpu, gpuDevices, environment: permittedEnvironment, executable: runtimeExecutableInvocationTarget,
        arguments: args.map((argument) => mapWorkArgument(argument, resolvedSourceRoot)),
        immutableWorkRoot: requireImmutableWorkRoot,
      });
      if (executionBackend === 'docker') {
        launcher = docker;
        const uid = typeof process.getuid === 'function' ? process.getuid() : 65534;
        const gid = typeof process.getgid === 'function' ? process.getgid() : 65534;
        const dockerExecutable = containerImage ? containerExecutable : runtimeExecutableInvocationTarget;
        const datasetSupervisor = requireDatasetAccessProof ? activeExecutionIdentity?.datasetAccessSupervisor : null;
        command = buildDockerWorkerCommand({
          limits: { memory: boundedMemory, cpu: boundedCpu, pids: boundedPids }, uid, gid,
          environment: permittedEnvironment, requiresGpu,
          systemMounts: containerImage ? [] : dockerSystemMounts(resolvedExecutable),
          workRoot, outputRoot, supervisorRoot, runtimeExecutableSnapshot, runtimeExecutableOverlayTarget,
          mountedDatasets, relativeCwd, containerImageDigest, datasetSupervisor, executable: dockerExecutable,
          arguments: args.map((argument) => mapWorkArgument(argument, resolvedSourceRoot)),
          immutableWorkRoot: requireImmutableWorkRoot,
        });
      }
      if (requireDatasetAccessProof && executionBackend === 'bubblewrap') {
        command = ['-f', '-qq', '-yy', '-e', 'trace=open,openat,read', '-o', datasetAccessTracePath, '--', launcher, ...command];
        launcher = DATASET_ACCESS_SUPERVISOR_TRACER;
      }
      const immutableWorkRootMountVerified = requireImmutableWorkRoot === true
        && (executionBackend === 'docker'
          ? command.some((argument) => argument === `${workRoot}:/work:ro`)
          : command.some((argument, index) => argument === '--ro-bind'
            && command[index + 1] === workRoot && command[index + 2] === '/work'));
      if (requireImmutableWorkRoot && !immutableWorkRootMountVerified) {
        removePrivateSandboxRoot(sandboxRoot);
        return {
          ok: false,
          status: 'os_sandbox_worker_blocked',
          blockers: ['worker_immutable_work_root_mount_unverified'],
          availability: executionAvailability,
          isolation: {
            kernelNetworkIsolationVerified: false,
            filesystemNamespaceVerified: false,
            sourceReadOnlyVerified: false,
            immutableWorkRootVerified: false,
            resourceLimitsVerified: false,
          },
        };
      }
      const finalize = (result) => {
        const sourceExecutionSnapshotAfter = inspectWorkspaceExecutionSnapshot(resolvedSourceRoot, { excludeRoots: sourceDatasetRoots, excludeNames: sourceExcludedNames });
        const sourceMerkleHashAfter = sourceExecutionSnapshotAfter.merkleHash;
        const sourceWorkspaceManifestHashAfter = sourceExecutionSnapshotAfter.manifestHash;
        const sourceMutationDetected = sourceExecutionSnapshotAfter.blockers.length > 0 || sourceMerkleHashAfter !== sourceMerkleHashBefore || sourceWorkspaceManifestHashAfter !== sourceWorkspaceManifestHashBefore;
        const finalizedDatasets = mountedDatasets.map((mount) => {
          const manifestHashAfter = safeStrictDatasetManifestHash(mount.source, mount.allowedDatasetRoot);
          const snapshotManifestHashAfter = safeStrictDatasetManifestHash(
            mount.snapshotSource,
            mount.sourceType === 'file' ? mount.bindSource : mount.snapshotSource,
          );
          return {
            ...mount,
            manifestHashAfter,
            manifestVerifiedAfterExecution: manifestHashAfter === mount.manifestHashBefore,
            snapshotManifestHashAfter,
            snapshotVerifiedAfterExecution: snapshotManifestHashAfter === mount.snapshotManifestHash,
          };
        });
        const datasetMutationDetected = finalizedDatasets.some((mount) => !mount.manifestVerifiedAfterExecution || !mount.snapshotVerifiedAfterExecution);
        const datasetSnapshotMutationDetected = finalizedDatasets.some((mount) => !mount.snapshotVerifiedAfterExecution);
        const datasetAccess = buildDatasetRuntimeAccessReceipt({
          tracePath: datasetAccessTracePath,
          supervisorRoot,
          executionBackend,
          datasets: finalizedDatasets,
          required: requireDatasetAccessProof,
          supervisorIdentityPath: datasetAccessSupervisorIdentityPath,
          expectedSupervisor: activeExecutionIdentity?.datasetAccessSupervisor || null,
          runtimeIdentityHash: activeExecutionIdentity?.runtimeIdentityHash || null,
          environmentBindingHash,
          containerImageDigest,
          traceOwnerUid: typeof process.getuid === 'function' ? process.getuid() : 65534,
          traceOwnerGid: typeof process.getgid === 'function' ? process.getgid() : 65534,
          workloadExitCode: result.status,
        });
        const datasetAccessReceipt = datasetAccess.receipt;
        const datasetAccessBlockers = datasetAccess.blockers;
        let runtimeExecutableSnapshotHashAfter = null;
        try { runtimeExecutableSnapshotHashAfter = runtimeExecutableSnapshot ? fileSha256Hash(runtimeExecutableSnapshot.path) : null; } catch { runtimeExecutableSnapshotHashAfter = null; }
        const runtimeExecutableSnapshotVerified = !runtimeExecutableSnapshot || runtimeExecutableSnapshotHashAfter === runtimeExecutableSnapshot.hash;
        const commandPassed = result.status === 0 && !result.error && !result.aborted && !result.timedOut;
        let passed = commandPassed && !sourceMutationDetected && !datasetMutationDetected && !datasetAccessBlockers.length && runtimeExecutableSnapshotVerified;
        const artifacts = [], artifactBlockers = []; let artifactOutputBytes = 0;
        if (passed && resolvedOutputDirectory) {
          for (const declared of outputPaths.map(String)) {
            let selectedSourceRoot = null;
            for (const candidateRoot of requireSeparateOutputRoot ? [outputRoot] : [outputRoot, workRoot]) {
              try {
                fs.lstatSync(path.resolve(candidateRoot, declared));
                selectedSourceRoot = candidateRoot;
                break;
              } catch (error) {
                if (error?.code !== 'ENOENT') {
                  artifactBlockers.push(`worker_output_path_unsafe:${declared}:${error?.code || 'lstat_failed'}`);
                  break;
                }
              }
            }
            if (!selectedSourceRoot) {
              if (requireSeparateOutputRoot) artifactBlockers.push(`worker_declared_output_missing_from_separate_root:${declared}`);
              continue;
            }
            let staged = null;
            try {
              const destination = path.resolve(resolvedOutputDirectory, declared);
              const destinationRelative = path.relative(allowedOutputRoot, destination).replace(/\\/g, '/');
              const source = inspectScopedRegularFileSync({ scopeRoot: selectedSourceRoot, relative: declared });
              artifactOutputBytes += source.bytes;
              if (artifactOutputBytes > boundedOutput) { const error = new Error('worker_output_bytes_limit_exceeded'); error.code = 'worker_output_bytes_limit_exceeded'; throw error; }
              const current = inspectScopedRegularFileWithRecoverySync({ scopeRoot: allowedOutputRoot, relative: destinationRelative });
              if (current.hash === source.hash) {
                artifacts.push({ path: declared, sha256: current.hash, bytes: current.bytes });
                continue;
              }
              staged = stageScopedRegularFileCopySync({
                sourceRoot: selectedSourceRoot,
                destinationRoot: allowedOutputRoot,
                relative: declared,
                destinationRelative,
                stageId: `os-sandbox-output:${crypto.createHash('sha256').update(`${sourceMerkleHashBefore}\0${allowedOutputRoot}\0${destinationRelative}\0${declared}\0${current.hash}\0${source.hash}`).digest('hex')}`,
                expectedHash: current.hash,
              });
              const persisted = commitStagedScopedFileSync(staged, { destinationRoot: allowedOutputRoot, expectedHash: current.hash });
              artifacts.push({ path: declared, sha256: persisted.hash, bytes: persisted.bytes });
            } catch (error) {
              artifactBlockers.push(`worker_output_path_unsafe:${declared}:${error?.code || 'materialization_failed'}`);
            } finally {
              abortStagedScopedFileSync(staged);
            }
          }
        }
        passed = passed && artifactBlockers.length === 0;
        const receiptPayload = {
          version: 4,
          kind: 'OsSandboxWorkerReceipt',
          runnerId: `${executionBackend}-kernel-isolation-worker-v4`,
          backend: executionBackend,
          status: result.aborted ? 'os_sandbox_worker_cancelled' : passed ? 'os_sandbox_worker_passed' : 'os_sandbox_worker_failed',
          exitCode: result.status,
          signal: result.signal || null,
          stdout: String(result.stdout || ''),
          stderr: String(result.stderr || result.error?.message || ''),
          sourceMerkleHashBefore,
          sourceMerkleHashAfter,
          sourceWorkspaceManifestHashBefore,
          sourceWorkspaceManifestHashAfter,
          workSourceMerkleHash,
          workWorkspaceManifestHash,
          expectedSourceMerkleHash: expectedSourceMerkleHash ? String(expectedSourceMerkleHash).toLowerCase() : null,
          expectedSourceWorkspaceManifestHash: expectedSourceWorkspaceManifestHash ? String(expectedSourceWorkspaceManifestHash).toLowerCase() : null,
          sourceMutationDetected,
          datasetMutationDetected,
          declaredOutputPaths: outputPaths.map(String),
          declaredOutputsRestrictedToSeparateRoot: requireSeparateOutputRoot === true,
          artifacts,
          artifactManifestHash: hashRecord('OsSandboxWorkerArtifactManifest', artifacts),
          limits: { timeoutMs: boundedTimeout, memoryBytes: boundedMemory, cpuSeconds: boundedCpu, maximumPids: boundedPids, maximumOutputBytes: boundedOutput, maximumCapturedBytes },
          runtimeIdentityType: activeExecutionIdentity?.runtimeType || (executionBackend === 'docker' ? 'container' : 'host'),
          runtimeIdentityHash: activeExecutionIdentity?.runtimeIdentityHash || null,
          runtimeExecutableSnapshotHash: runtimeExecutableSnapshot?.hash || null,
          runtimeExecutableSnapshotHashAfter,
          runtimeExecutableInvocationName: runtimeExecutableSnapshot?.invocationName || null,
          runtimeExecutableInvocationPath: runtimeExecutableSnapshot ? activeExecutionIdentity.executableInvocationPath : null,
          runtimeExecutableOverlayTarget: runtimeExecutableSnapshot ? runtimeExecutableOverlayTarget : null,
          containerImage: executionBackend === 'docker' ? selectedImage : null,
          containerImageDigest,
          environmentBindingHash,
          environmentBom: environmentBomBinding.environmentBom, environmentBomHash: environmentBomBinding.environmentBomHash,
          ...completeWorkerProcessIdentity({ processInvocationId, result }),
          executionBindings: Object.freeze(Object.fromEntries(permittedEnvironment
            .filter(([key]) => key.startsWith('HEPTA_BENCHMARK_') || key.startsWith('HEPTA_EXPERIMENT_') || ['HEPTA_PRE_DATA_ACCESS_FREEZE_HASH', 'HEPTA_HARNESS_CELL_ID', 'HEPTA_DATASET_AUTHORIZATION_SET_HASH', 'HEPTA_SEED', 'PYTHONHASHSEED'].includes(key))
            .map(([key, value]) => [key, String(value)])
            .sort(([left], [right]) => left.localeCompare(right)))),
          datasetAuthorizationSetHash: datasetAuthorizationSet.datasetAuthorizationSetHash,
          datasetMounts: finalizedDatasets.map((mount) => ({ name: mount.name, target: mount.target, sourceType: mount.sourceType, fileName: mount.fileName,
            readOnly: true, manifestHash: mount.manifestHash, manifestHashBefore: mount.manifestHashBefore, snapshotManifestHash: mount.snapshotManifestHash, manifestHashAfter: mount.manifestHashAfter,
            manifestVerifiedAfterExecution: mount.manifestVerifiedAfterExecution, snapshotManifestHashAfter: mount.snapshotManifestHashAfter, snapshotVerifiedAfterExecution: mount.snapshotVerifiedAfterExecution,
            licenseId: mount.licenseId, operatorAuthorizationHash: mount.operatorAuthorizationHash || null, operatorDatasetAuthorityDocumentHash: mount.operatorDatasetAuthorityDocumentHash || null,
            operatorDatasetAuthority: mount.operatorDatasetAuthority || null, splitManifestHash: mount.splitManifestHash || null, benchmarkHarnessDocumentHash: mount.benchmarkHarnessDocumentHash || null,
            benchmarkHarnessDefinitionHash: mount.benchmarkHarnessDefinitionHash || null, benchmarkFamily: mount.benchmarkFamily || null, benchmarkSeedSchedule: mount.benchmarkSeedSchedule || [], benchmarkMinimumRepetitions: mount.benchmarkMinimumRepetitions || 0, analysisProtocol: mount.analysisProtocol || null, analysisProtocolHash: mount.analysisProtocolHash || null })),
          datasetAccessReceipt,
          datasetAccessSupervisorIdentityHash: datasetAccessReceipt?.supervisor?.identityHash || null,
          isolation: {
            kernelNetworkIsolationVerified: true,
            filesystemNamespaceVerified: true,
            sourceReadOnlyVerified: !sourceMutationDetected,
            sourceReadOnlyMount: true,
            ephemeralWorkRootVerified: true,
            immutableWorkRootVerified: immutableWorkRootMountVerified,
            workspaceExecutionSnapshotVerified: true,
            separateOutputRootVerified: requireSeparateOutputRoot
              ? outputPaths.every((declared) => artifacts.some((artifact) => artifact.path === String(declared)))
              : true,
            hostEtcMounted: false,
            readOnlyRuntimeVerified: true,
            runtimeExecutableSnapshotVerified,
            immutableContainerImageVerified: executionBackend !== 'docker' || Boolean(containerImageDigest),
            datasetSnapshotsVerified: finalizedDatasets.every((mount) => mount.snapshotManifestHash === mount.manifestHash),
            datasetManifestsVerifiedAfterExecution: !datasetMutationDetected,
            datasetAccessSupervisorVerified: requireDatasetAccessProof
              ? datasetAccessReceipt?.status === 'dataset_runtime_access_verified'
              : true,
            memoryLimitVerified: true,
            cpuLimitVerified: true,
            processLimitVerified: processLimitProbe.available,
            processLimitMechanism: processLimitProbe.mechanism,
            resourceLimitsVerified: processLimitProbe.available,
            gpuAccessRequested: Boolean(requiresGpu),
            gpuDeviceIsolationVerified: !requiresGpu || gpuDevices.length > 0,
          },
          externalActionPerformed: false,
        };
        removePrivateSandboxRoot(sandboxRoot);
        return { ok: passed, ...receiptPayload, receiptHash: hashRecord('OsSandboxWorkerReceipt', receiptPayload), blockers: [...(result.aborted ? ['os_sandbox_command_aborted'] : []), ...(result.timedOut ? ['os_sandbox_command_timed_out'] : []), ...(!commandPassed && !result.aborted && !result.timedOut ? ['os_sandbox_command_failed'] : []), ...(sourceMutationDetected ? ['source_mutation_detected', ...sourceExecutionSnapshotAfter.blockers] : []), ...(datasetMutationDetected ? ['worker_dataset_manifest_changed_during_execution'] : []), ...(datasetSnapshotMutationDetected ? ['worker_dataset_snapshot_changed_during_execution'] : []), ...datasetAccessBlockers, ...(!runtimeExecutableSnapshotVerified ? ['worker_runtime_executable_snapshot_changed_during_execution'] : []), ...artifactBlockers] };
      };
      if (signal) {
        return runBoundedChildProcess({ executable: launcher, args: command, cwd: resolvedCwd, timeoutMs: boundedTimeout, signal, maximumCapturedBytes })
          .then(
            (result) => finalize({ ...result, status: result.exitCode, signal: result.signal }),
            (error) => { removePrivateSandboxRoot(sandboxRoot); throw error; },
          );
      }
      return finalize(executor(launcher, command, { encoding: 'utf8', timeout: boundedTimeout, maxBuffer: maximumCapturedBytes }));
    },
  });
}
