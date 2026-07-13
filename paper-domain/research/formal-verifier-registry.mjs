import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { verifyTrustedLedgerReceipt } from '../evidence/trusted-ledger-receipt.mjs';

export const FORMAL_VERIFIER_REGISTRY = Object.freeze({
  lean: Object.freeze({ kind: 'lean', command: 'lean', extension: '.lean', certificateKind: 'LeanFormalCertificate' }),
  coq: Object.freeze({ kind: 'coq', command: 'coqc', extension: '.v', certificateKind: 'CoqFormalCertificate' }),
  isabelle: Object.freeze({ kind: 'isabelle', command: 'isabelle', extension: '.thy', certificateKind: 'IsabelleFormalCertificate' }),
});

export function formalVerifierDescriptor(kind) {
  return FORMAL_VERIFIER_REGISTRY[String(kind || '').toLowerCase()] || null;
}

export function buildFormalVerifierRegistry({ adapterReceipts = [], receiptLedger = null } = {}) {
  const receipts = new Map((Array.isArray(adapterReceipts) ? adapterReceipts : []).map((item) => [item?.verifierKind, item]));
  const verifiers = Object.values(FORMAL_VERIFIER_REGISTRY).map((descriptor) => {
    const receipt = receipts.get(descriptor.kind) || null;
    const ledgerVerification = verifyTrustedLedgerReceipt({ receipt, ledgerReceiptId: receipt?.ledgerReceiptId, receiptLedger, expectedKinds: ['FormalVerifierAdapterReceipt'], expectedStatuses: ['formal_verifier_adapter_verified'], expectedStreams: ['formal-verifier-adapters'], expectedWriterKinds: ['formal-adapter-bootstrap'] });
    const adapterVerified = ledgerVerification.status === 'trusted_ledger_receipt_verified'
      && receipt?.status === 'formal_verifier_adapter_verified'
      && receipt?.verifierKind === descriptor.kind
      && receipt?.command === descriptor.command
      && receipt?.extension === descriptor.extension;
    return Object.freeze({ ...descriptor, adapterVerified, adapterReceiptHash: receipt?.receiptHash || null, adapterLedgerReceiptId: receipt?.ledgerReceiptId || null, status: adapterVerified ? 'formal_verifier_registered' : 'formal_verifier_unavailable', blockers: ledgerVerification.blockers });
  });
  const payload = { version: 1, kind: 'FormalVerifierRegistry', status: 'formal_verifier_registry_ready', verifiers, executablePresenceGrantsSupport: false };
  return Object.freeze({ ...payload, formalVerifierRegistryHash: hashRecord('FormalVerifierRegistry', payload) });
}
