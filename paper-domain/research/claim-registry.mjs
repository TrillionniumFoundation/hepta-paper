import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';

export function buildClaimRegistry({ paperTask, claims = [] } = {}) {
  const records = claims.map((claim, index) => ({
    claimId: String(claim.id || `claim-${index + 1}`),
    text: String(claim.text || claim.summary || ''),
    sourceLocator: claim.sourceLocator || claim.source_locator || null,
    status: claim.status || 'candidate',
    dependencyIds: Array.isArray(claim.dependencyIds) ? [...claim.dependencyIds].map(String).sort() : [],
  }));
  const record = { version: 1, kind: 'ClaimRegistry', paperId: paperTask?.paperId || null, claims: records };
  return { ...record, claimRegistryHash: hashPaperRecord('ClaimRegistry', record) };
}

