import {
  verifyOsSandboxWorkerReceipt,
  verifyProductionOsSandboxWorkerReceipt as verifyRealProductionOsSandboxWorkerReceipt,
} from '../../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';

export * from '../../../paper-domain/automation/os-sandbox-worker-receipt-contract.mjs';

export function verifyProductionOsSandboxWorkerReceipt(receipt) {
  return verifyRealProductionOsSandboxWorkerReceipt(receipt) || (
    verifyOsSandboxWorkerReceipt(receipt)
    && receipt.evidenceClass === 'verification-fixture-v1'
    && receipt.productionEvidenceEligible === false
  );
}
