import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  fileSha256Hash,
  inspectWorkspaceExecutionSnapshot,
  safeStrictDatasetManifestHash,
} from './execution-snapshot.mjs';
import {
  abortStagedScopedFileSync,
  commitStagedScopedFileSync,
  inspectScopedRegularFileSync,
  inspectScopedRegularFileWithRecoverySync,
  stageScopedRegularFileCopySync,
} from './scoped-file-materialization-repository.mjs';
import { buildDatasetRuntimeAccessReceipt } from './dataset-runtime-access-receipt.mjs';
import { completeWorkerProcessIdentity } from './os-sandbox-worker-runtime-support.mjs';

export function removePrivateSandboxRoot(sandboxRoot) {
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

export function createOsSandboxWorkerExecutionFinalizer({
  activeExecutionIdentity,
  allowedOutputRoot,
  boundedCpu,
  boundedMemory,
  boundedOutput,
  boundedPids,
  boundedTimeout,
  containerImageDigest,
  datasetAccessSupervisorIdentityPath,
  datasetAccessTracePath,
  datasetAuthorizationSet,
  environmentBindingHash,
  environmentBomBinding,
  executionBackend,
  expectedSourceMerkleHash,
  expectedSourceWorkspaceManifestHash,
  gpuDevices,
  immutableWorkRootMountVerified,
  maximumCapturedBytes,
  mountedDatasets,
  outputPaths,
  outputRoot,
  permittedEnvironment,
  processInvocationId,
  processLimitProbe,
  requireDatasetAccessProof,
  requireSeparateOutputRoot,
  requiresGpu,
  resolvedOutputDirectory,
  resolvedSourceRoot,
  runtimeExecutableOverlayTarget,
  runtimeExecutableSnapshot,
  sandboxRoot,
  selectedImage,
  sourceDatasetRoots,
  sourceExcludedNames,
  sourceMerkleHashBefore,
  sourceWorkspaceManifestHashBefore,
  supervisorRoot,
  workRoot,
  workSourceMerkleHash,
  workWorkspaceManifestHash,
}) {
  return (result) => {
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
          dockerWorkerContainerRecoveryReceipt: result.dockerWorkerContainerRecoveryReceipt || null,
          ...completeWorkerProcessIdentity({ processInvocationId, result }),
          executionBindings: Object.freeze(Object.fromEntries(permittedEnvironment
            .filter(([key]) => key.startsWith('HEPTA_BENCHMARK_') || key.startsWith('HEPTA_EXPERIMENT_') || ['HEPTA_PRE_DATA_ACCESS_FREEZE_HASH', 'HEPTA_HARNESS_CELL_ID', 'HEPTA_DATASET_AUTHORIZATION_SET_HASH', 'HEPTA_DATASET_RESEARCH_COMPATIBILITY_HASH', 'HEPTA_SEED', 'PYTHONHASHSEED'].includes(key))
            .map(([key, value]) => [key, String(value)])
            .sort(([left], [right]) => left.localeCompare(right)))),
          datasetAuthorizationSetHash: datasetAuthorizationSet.datasetAuthorizationSetHash,
          datasetMounts: finalizedDatasets.map((mount) => ({ name: mount.name, target: mount.target, sourceType: mount.sourceType, fileName: mount.fileName,
            readOnly: true, manifestHash: mount.manifestHash, manifestHashBefore: mount.manifestHashBefore, snapshotManifestHash: mount.snapshotManifestHash, manifestHashAfter: mount.manifestHashAfter,
            manifestVerifiedAfterExecution: mount.manifestVerifiedAfterExecution, snapshotManifestHashAfter: mount.snapshotManifestHashAfter, snapshotVerifiedAfterExecution: mount.snapshotVerifiedAfterExecution,
            licenseId: mount.licenseId, operatorAuthorizationHash: mount.operatorAuthorizationHash || null, operatorDatasetAuthorityDocumentHash: mount.operatorDatasetAuthorityDocumentHash || null,
            operatorDatasetAuthority: mount.operatorDatasetAuthority || null,
            ...(mount.operatorDatasetResearchSemantics ? {
              operatorDatasetResearchSemantics: mount.operatorDatasetResearchSemantics,
              operatorDatasetResearchSemanticsHash:
                mount.operatorDatasetResearchSemanticsHash || null,
            } : {}),
            ...(mount.authorityScope ? {
              authorityScope: mount.authorityScope,
              evidenceClass: mount.evidenceClass || null,
              academicPromotionEligible: mount.academicPromotionEligible === true,
              externalTrustClaimed: mount.externalTrustClaimed === true,
              localGoldenRuntimeScope: mount.localGoldenRuntimeScope || null,
            } : {}),
            splitManifestHash: mount.splitManifestHash || null, benchmarkHarnessDocumentHash: mount.benchmarkHarnessDocumentHash || null,
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
        const containerRecoveryBlockers = result.dockerWorkerContainerRecoveryReceipt?.blockers || [];
        if (!containerRecoveryBlockers.length) removePrivateSandboxRoot(sandboxRoot);
        return { ok: passed, ...receiptPayload, receiptHash: hashRecord('OsSandboxWorkerReceipt', receiptPayload), blockers: [...(result.aborted ? ['os_sandbox_command_aborted'] : []), ...(result.timedOut ? ['os_sandbox_command_timed_out'] : []), ...(!commandPassed && !result.aborted && !result.timedOut ? ['os_sandbox_command_failed'] : []), ...(sourceMutationDetected ? ['source_mutation_detected', ...sourceExecutionSnapshotAfter.blockers] : []), ...(datasetMutationDetected ? ['worker_dataset_manifest_changed_during_execution'] : []), ...(datasetSnapshotMutationDetected ? ['worker_dataset_snapshot_changed_during_execution'] : []), ...datasetAccessBlockers, ...(!runtimeExecutableSnapshotVerified ? ['worker_runtime_executable_snapshot_changed_during_execution'] : []), ...artifactBlockers, ...containerRecoveryBlockers] };
      };
}
