import {
  verifyOsSandboxWorkerReceipt,
  verifyProductionOsSandboxWorkerReceipt as verifyRealProductionOsSandboxWorkerReceipt,
} from '../../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';

function verifyRawEventRecomputationFixtureReceipt(receipt) {
  try {
    return verifyOsSandboxWorkerReceipt(receipt)
      && receipt.evidenceClass === 'verification-fixture-v1'
      && receipt.productionEvidenceEligible === false
      && ['bubblewrap', 'docker', 'fixture'].includes(receipt.backend)
      && receipt.runnerId === `${receipt.backend}-kernel-isolation-worker-v4`
      && receipt.isolation?.memoryLimitVerified === true
      && receipt.isolation?.memoryLimitScope
        === (receipt.backend === 'docker'
          ? 'container-cgroup-aggregate-v1'
          : 'process-address-space-not-descendant-tree-v1')
      && receipt.isolation?.cpuLimitVerified === true
      && receipt.isolation?.cpuLimitScope
        === 'process-thread-group-not-descendant-tree-v1'
      && receipt.isolation?.processLimitVerified === true
      && receipt.isolation?.resourceLimitsVerified === true
      && receipt.isolation?.processLimitMechanism === (receipt.backend === 'docker'
        ? 'docker-pids-cgroup' : 'rlimit-nproc')
      && receipt.isolation?.processLimitScope
        === (receipt.backend === 'docker'
          ? 'container-cgroup-concurrent-tasks-v1'
          : 'real-uid-concurrent-processes-not-sandbox-local-v1');
  } catch {
    return false;
  }
}

export function verifyProductionOsSandboxWorkerReceipt(receipt) {
  return verifyRealProductionOsSandboxWorkerReceipt(receipt)
    || verifyRawEventRecomputationFixtureReceipt(receipt);
}
