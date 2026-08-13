import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildDatasetAuthorizationSet } from './experiment-run-artifact-contract.mjs';
import { verifyWorkerDatasetRuntimeAccessBinding } from './dataset-runtime-access-contract.mjs';
import { verifyWorkerProcessExecutionIdentity } from './worker-process-execution-contract.mjs';
import { verifyEnvironmentBomAgainstWorkerReceipt } from './environment-bom-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function verifyOsSandboxWorkerReceipt(receipt) {
  if (!receipt || receipt.ok !== true || receipt.status !== 'os_sandbox_worker_passed') return false;
  const { receiptHash } = receipt;
  const payload = { ...receipt };
  delete payload.ok;
  delete payload.receiptHash;
  delete payload.blockers;
  if (!SHA256.test(String(receiptHash || '')) || hashRecord('OsSandboxWorkerReceipt', payload) !== receiptHash) return false;
  if (!SHA256.test(String(receipt.artifactManifestHash || ''))
    || hashRecord('OsSandboxWorkerArtifactManifest', receipt.artifacts || []) !== receipt.artifactManifestHash) return false;
  const sourceHashes = [receipt.sourceMerkleHashBefore, receipt.sourceMerkleHashAfter, receipt.workSourceMerkleHash,
    receipt.sourceWorkspaceManifestHashBefore, receipt.sourceWorkspaceManifestHashAfter, receipt.workWorkspaceManifestHash];
  if (!SHA256.test(String(receipt.runtimeIdentityHash || ''))
    || !SHA256.test(String(receipt.environmentBindingHash || ''))
    || sourceHashes.some((value) => !SHA256.test(String(value || '')))
    || !verifyWorkerProcessExecutionIdentity(receipt)
    || !verifyEnvironmentBomAgainstWorkerReceipt(receipt.environmentBom, receipt)) return false;
  const datasetAuthorizations = buildDatasetAuthorizationSet(receipt.datasetMounts || []);
  if (receipt.datasetAuthorizationSetHash !== datasetAuthorizations.datasetAuthorizationSetHash
    || receipt.executionBindings?.HEPTA_DATASET_AUTHORIZATION_SET_HASH !== datasetAuthorizations.datasetAuthorizationSetHash) return false;
  if (!verifyWorkerDatasetRuntimeAccessBinding(receipt)) return false;
  return receipt.isolation?.kernelNetworkIsolationVerified === true
    && receipt.isolation?.sourceReadOnlyVerified === true
    && receipt.isolation?.ephemeralWorkRootVerified === true
    && receipt.isolation?.separateOutputRootVerified === true
    && receipt.sourceMerkleHashBefore === receipt.sourceMerkleHashAfter
    && receipt.sourceMerkleHashBefore === receipt.workSourceMerkleHash
    && receipt.sourceWorkspaceManifestHashBefore === receipt.sourceWorkspaceManifestHashAfter
    && receipt.sourceWorkspaceManifestHashBefore === receipt.workWorkspaceManifestHash;
}

export function verifyProductionOsSandboxWorkerReceipt(receipt) {
  try {
    return verifyOsSandboxWorkerReceipt(receipt)
      && ['bubblewrap', 'docker'].includes(receipt.backend)
      && receipt.runnerId === `${receipt.backend}-kernel-isolation-worker-v4`
      && receipt.isolation?.memoryLimitVerified === true
      && receipt.isolation?.memoryLimitScope === (receipt.backend === 'docker'
        ? 'container-cgroup-aggregate-v1'
        : 'process-address-space-not-descendant-tree-v1')
      && receipt.isolation?.cpuLimitVerified === true
      && receipt.isolation?.cpuLimitScope
        === 'process-thread-group-not-descendant-tree-v1'
      && receipt.isolation?.processLimitVerified === true
      && receipt.isolation?.resourceLimitsVerified === true
      && receipt.isolation?.processLimitMechanism === (receipt.backend === 'docker'
        ? 'docker-pids-cgroup' : 'rlimit-nproc')
      && receipt.isolation?.processLimitScope === (receipt.backend === 'docker'
        ? 'container-cgroup-concurrent-tasks-v1'
        : 'real-uid-concurrent-processes-not-sandbox-local-v1');
  } catch { return false; }
}
