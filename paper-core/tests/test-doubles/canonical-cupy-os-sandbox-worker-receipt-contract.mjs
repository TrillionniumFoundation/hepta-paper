import {
  verifyOsSandboxWorkerReceipt,
  verifyProductionOsSandboxWorkerReceipt as verifyRealProductionOsSandboxWorkerReceipt,
} from '../../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';

export * from '../../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';

// Shared fixture seam for the canonical CuPy PDE and deep-learning workers.
// Keep the production verifier untouched: this fallback is deliberately
// marked non-eligible and is only accepted by test doubles.
export function verifyProductionOsSandboxWorkerReceipt(receipt) {
  return verifyRealProductionOsSandboxWorkerReceipt(receipt) || (
    verifyOsSandboxWorkerReceipt(receipt)
    && receipt.evidenceClass === 'verification-fixture-v1'
    && receipt.productionEvidenceEligible === false
  );
}
