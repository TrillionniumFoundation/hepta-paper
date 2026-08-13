import {
  verifyOsSandboxWorkerReceipt,
  verifyProductionOsSandboxWorkerReceipt as verifyRealProductionOsSandboxWorkerReceipt,
} from '../../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';

function verifyRawEventRecomputationFixtureReceipt(receipt) {
  try {
    return verifyOsSandboxWorkerReceipt(receipt)
      && receipt.backend === 'fixture'
      && receipt.runnerId === 'fixture-kernel-isolation-worker-v4'
      && receipt.isolation?.memoryLimitVerified === true
      && receipt.isolation?.memoryLimitScope
        === 'process-address-space-not-descendant-tree-v1'
      && receipt.isolation?.cpuLimitVerified === true
      && receipt.isolation?.cpuLimitScope
        === 'process-thread-group-not-descendant-tree-v1'
      && receipt.isolation?.processLimitVerified === true
      && receipt.isolation?.resourceLimitsVerified === true
      && receipt.isolation?.processLimitMechanism === 'rlimit-nproc'
      && receipt.isolation?.processLimitScope
        === 'real-uid-concurrent-processes-not-sandbox-local-v1';
  } catch {
    return false;
  }
}

export function verifyProductionOsSandboxWorkerReceipt(receipt) {
  return verifyRealProductionOsSandboxWorkerReceipt(receipt)
    || verifyRawEventRecomputationFixtureReceipt(receipt);
}
