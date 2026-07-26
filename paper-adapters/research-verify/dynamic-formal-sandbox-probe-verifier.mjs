import {
  PRODUCTION_LEAN_TOOLCHAIN,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import {
  verifyOsSandboxWorkerReceipt,
} from '../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';
import { createOsSandboxedWorkerRunner } from '../runtime/os-sandboxed-worker-runner.mjs';
import { createFormalProjectSnapshotRepository } from './formal-project-snapshot-repository.mjs';
import {
  buildSealedFormalLeanProbeEnvironment,
} from './sealed-formal-lean-probe-environment.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function sandboxSnapshotIdentityVerified(receipt, snapshotSealReceipt) {
  const sourceMerkleHash = String(receipt?.sourceMerkleHashBefore || '');
  const sourceManifestHash = String(
    receipt?.sourceWorkspaceManifestHashBefore || '',
  );
  const sealedMerkleHash = String(
    snapshotSealReceipt?.workspaceExecutionMerkleHash || '',
  );
  const sealedManifestHash = String(
    snapshotSealReceipt?.workspaceExecutionManifestHash || '',
  );
  return SHA256.test(sourceMerkleHash)
    && SHA256.test(sourceManifestHash)
    && SHA256.test(sealedMerkleHash)
    && SHA256.test(sealedManifestHash)
    && sourceMerkleHash === sealedMerkleHash
    && sourceManifestHash === sealedManifestHash
    && receipt.sourceMerkleHashAfter === sourceMerkleHash
    && receipt.workSourceMerkleHash === sourceMerkleHash
    && receipt.sourceWorkspaceManifestHashAfter === sourceManifestHash
    && receipt.workWorkspaceManifestHash === sourceManifestHash
    && receipt.sourceMutationDetected === false
    && receipt.isolation?.workspaceExecutionSnapshotVerified === true;
}

export function executeDynamicFormalSandboxProbe({
  manifest,
  closure,
  projectRoot,
  projectScopeRoot,
  probeRelativePath,
  environment,
  pinnedRuntime,
  formalSandboxRuntimeConfiguration,
  readClosure,
  spawnSyncImpl,
  sandboxProbeRunnerFactory = createOsSandboxedWorkerRunner,
  projectSnapshotRepository = createFormalProjectSnapshotRepository(),
  verifySandboxProbeReceipt = verifyOsSandboxWorkerReceipt,
} = {}) {
  const blockers = [];
  let sandboxProbeReceipt = null;
  let snapshotSealReceipt = null;
  let snapshot = null;
  try {
    snapshot = projectSnapshotRepository.materialize({
      projectRoot,
      dependencyScopeRoot: projectScopeRoot,
      projectFiles: closure.files,
    });
    snapshotSealReceipt = snapshot.seal();
    if (snapshotSealReceipt.writableFileCount !== 0
      || snapshotSealReceipt.writableDirectoryCount !== 0) {
      blockers.push('dynamic_formal_sandbox_probe_snapshot_not_sealed');
    }
    const snapshotBefore = readClosure({
      projectRoot: snapshot.root,
      dependencyScopeRoot: snapshot.scopeRoot,
    });
    if (snapshotBefore?.status !== 'formal_project_closure_verified') {
      blockers.push('dynamic_formal_sandbox_probe_snapshot_invalid');
    } else {
      const sealedLeanEnvironment = buildSealedFormalLeanProbeEnvironment({
        manifest,
        snapshotScopeRoot: snapshot.scopeRoot,
        snapshotProjectRoot: snapshot.root,
        toolchainRoot: pinnedRuntime.toolchainRoot,
      });
      const runner = sandboxProbeRunnerFactory({
        allowedExecutables: [pinnedRuntime.leanExecutable],
        allowedRoots: [snapshot.scopeRoot],
        dockerImage: formalSandboxRuntimeConfiguration.image,
        allowedContainerImages: [formalSandboxRuntimeConfiguration.image],
        maximumTimeoutMs: 120_000,
        maximumCpuSeconds: 120,
        maximumPids: 64,
        maximumCapturedBytes: 2 * 1024 * 1024,
        executor: spawnSyncImpl,
      });
      sandboxProbeReceipt = runner.run({
        executable: pinnedRuntime.leanExecutable,
        args: [probeRelativePath],
        cwd: snapshot.root,
        sourceRoot: snapshot.scopeRoot,
        timeoutMs: 120_000,
        outputPaths: [],
        env: {
          ELAN_HOME: environment.ELAN_HOME
            || `${environment.HOME || ''}/.elan`,
          ELAN_TOOLCHAIN: PRODUCTION_LEAN_TOOLCHAIN,
          ...sealedLeanEnvironment,
        },
        language: 'lean',
        determinismPolicy: 'dynamic-formal-readiness-probe-v1',
        requireImmutableWorkRoot: true,
        expectedSourceMerkleHash:
          snapshotSealReceipt.workspaceExecutionMerkleHash,
        expectedSourceWorkspaceManifestHash:
          snapshotSealReceipt.workspaceExecutionManifestHash,
      });
      if (sandboxProbeReceipt?.then) {
        blockers.push('dynamic_formal_sandbox_probe_must_be_synchronous');
      } else {
        if (!verifySandboxProbeReceipt(sandboxProbeReceipt)
          || sandboxProbeReceipt?.status !== 'os_sandbox_worker_passed'
          || sandboxProbeReceipt?.blockers?.length !== 0
          || sandboxProbeReceipt?.ok !== true
          || sandboxProbeReceipt.backend !== 'docker'
          || sandboxProbeReceipt.runtimeIdentityType !== 'container'
          || sandboxProbeReceipt.containerImageDigest
            !== formalSandboxRuntimeConfiguration.imageDigest
          || !SHA256.test(String(sandboxProbeReceipt.runtimeIdentityHash || ''))
          || !SHA256.test(String(sandboxProbeReceipt.receiptHash || ''))
          || !SHA256.test(String(
            sandboxProbeReceipt.executionProcessIdentityHash || '',
          ))
          || sandboxProbeReceipt.isolation?.immutableWorkRootVerified !== true) {
          blockers.push('dynamic_formal_sandbox_mathlib_probe_failed');
        }
        // The generic runner independently hashes the sealed source before
        // execution, its private work copy, and the source after execution.
        // The seal-bound expected hashes close the lineage to the verified
        // formal snapshot without a redundant fourth full-tree scan.
        if (!sandboxSnapshotIdentityVerified(
          sandboxProbeReceipt,
          snapshotSealReceipt,
        )) {
          blockers.push('dynamic_formal_sandbox_probe_snapshot_changed');
        }
      }
    }
  } catch (error) {
    if (String(error?.message || error).includes(
      'formal_project_snapshot_input_mismatch',
    )) {
      blockers.push('dynamic_formal_project_closure_changed_during_probe');
    }
    blockers.push(`dynamic_formal_sandbox_probe_failed:${String(
      error?.message || error,
    )}`);
  } finally {
    snapshot?.cleanup();
  }
  return Object.freeze({
    sandboxProbeReceipt,
    snapshotSealReceipt,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
