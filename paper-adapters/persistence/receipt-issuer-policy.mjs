import {
  receiptIssuerPolicies,
  resolveReceiptIssuerPolicy,
} from '../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';

const issuedCapabilities = new WeakMap();
export { receiptIssuerPolicies };

export function issueReceiptWriterCapability(policyId) {
  const policy = resolveReceiptIssuerPolicy(policyId);
  if (!policy) throw new Error(`receipt issuer policy not registered:${policyId}`);
  const { issuerPolicyHash, ...definition } = policy;
  const descriptor = Object.freeze({
    version: 1,
    kind: 'ReceiptWriterCapability',
    policyId,
    ...definition,
    issuerPolicyHash,
  });
  const capability = Object.freeze({ policyId, issuerPolicyHash: descriptor.issuerPolicyHash });
  issuedCapabilities.set(capability, descriptor);
  return capability;
}

export function resolveReceiptWriterCapability(capability) {
  return capability && typeof capability === 'object' ? issuedCapabilities.get(capability) || null : null;
}
