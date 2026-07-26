import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import { createProofObligationContracts } from './theorem-specification.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/i;

export const validFormalCertificateHash = (value) => (
  HASH.test(String(value || ''))
);

export const validFormalCertificateId = (value) => (
  typeof value === 'string' && value.trim() === value && value.length > 0
);

export const formalCertificateSourceExtension = (value) => {
  const leaf = String(value || '').replace(/\\/g, '/').split('/').pop() || '';
  const index = leaf.lastIndexOf('.');
  return index > 0 ? leaf.slice(index).toLowerCase() : '';
};

export function canonicalFormalClosureClaimBindings(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const bindings = value.map((item) => ({
    claimId: validFormalCertificateId(item?.claimId) ? item.claimId : null,
    obligationId: validFormalCertificateId(item?.obligationId)
      ? item.obligationId
      : null,
    statementHash: validFormalCertificateHash(item?.statementHash)
      ? String(item.statementHash).toLowerCase()
      : null,
  }));
  if (bindings.some(
    (binding) => Object.values(binding).some((item) => item === null),
  )) return null;
  const keys = bindings.map(
    (binding) => `${binding.claimId}\u0000${binding.obligationId}`,
  );
  if (new Set(keys).size !== keys.length) return null;
  return bindings.sort((left, right) => (
    left.claimId.localeCompare(right.claimId)
      || left.obligationId.localeCompare(right.obligationId)
  ));
}

export function formalClosureClaimBindingsFromProposalBinding(proposalBinding) {
  const entries = Array.isArray(proposalBinding?.entries)
    ? proposalBinding.entries
    : [];
  if (!entries.length) return Object.freeze([]);
  const bindings = [];
  try {
    for (const entry of entries) {
      if (!validFormalCertificateId(entry?.theoremClaimId)
        || !validFormalCertificateId(entry?.theoremStatement)
        || !validFormalCertificateId(entry?.scientificClaimKey)) {
        return Object.freeze([]);
      }
      const statementHash = hashBytes(
        Buffer.from(entry.theoremStatement, 'utf8'),
      );
      const obligations = createProofObligationContracts({
        claimKey: entry.scientificClaimKey,
        proofObligations: entry.proofObligations,
      });
      for (const obligation of obligations) {
        bindings.push(Object.freeze({
          claimId: entry.theoremClaimId,
          obligationId: obligation.obligationId,
          statementHash,
        }));
      }
    }
  } catch {
    return Object.freeze([]);
  }
  const canonical = canonicalFormalClosureClaimBindings(bindings);
  return Object.freeze(
    (canonical || []).map((binding) => Object.freeze(binding)),
  );
}
