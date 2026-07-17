import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const COMPARATORS = new Set(['baseline', 'ablation']);
const ALTERNATIVES = new Set(['greater', 'less']);

export function empiricalManuscriptClaimHash({
  claimId,
  metric,
  comparator,
  alternative,
  minimumEffect,
  acceptanceRequired,
  proposalClaimRecordHash,
  manuscriptPath,
  manuscriptContentHash,
  manuscriptCorpusHash,
} = {}) {
  return hashRecord('EmpiricalManuscriptClaim', {
    claimId: String(claimId || ''),
    metric: String(metric || ''),
    comparator: String(comparator || ''),
    alternative: String(alternative || ''),
    minimumEffect: Number(minimumEffect),
    acceptanceRequired: acceptanceRequired === true,
    proposalClaimRecordHash: proposalClaimRecordHash || null,
    manuscriptPath: String(manuscriptPath || ''),
    manuscriptContentHash: manuscriptContentHash || null,
    manuscriptCorpusHash: manuscriptCorpusHash || null,
  });
}

export function verifyEmpiricalClaimUniverse(universe) {
  if (!universe || universe.version !== 1 || universe.kind !== 'EmpiricalClaimUniverse'
    || universe.status !== 'empirical_claim_universe_verified'
    || !SHA256.test(String(universe.manuscriptCorpusHash || ''))
    || !SHA256.test(String(universe.sourceCorpusHash || ''))
    || !SHA256.test(String(universe.empiricalClaimUniverseHash || ''))
    || !SHA256.test(String(universe.empiricalClaimUniverseReceiptHash || ''))
    || !Array.isArray(universe.files) || !universe.files.length
    || !Array.isArray(universe.claims) || !universe.claims.length
    || !Array.isArray(universe.blockers) || universe.blockers.length) return false;
  const ids = new Set();
  for (const claim of universe.claims) {
    if (!exactKeys(claim, [
      'version', 'kind', 'claimId', 'metric', 'comparator', 'alternative', 'minimumEffect',
      'acceptanceRequired', 'proposalClaimRecordHash', 'manuscriptPath', 'manuscriptFileHash',
      'markerByteStart', 'markerByteEnd', 'manuscriptByteStart', 'manuscriptByteEnd',
      'manuscriptContentHash', 'text', 'manuscriptClaimHash', 'empiricalClaimUniverseEntryHash',
    ]) || claim.version !== 1 || claim.kind !== 'EmpiricalClaimUniverseEntry'
      || !IDENTIFIER.test(String(claim.claimId || '')) || ids.has(claim.claimId)
      || !IDENTIFIER.test(String(claim.metric || '')) || !COMPARATORS.has(claim.comparator)
      || !ALTERNATIVES.has(claim.alternative) || !Number.isFinite(Number(claim.minimumEffect))
      || Number(claim.minimumEffect) < 0 || typeof claim.acceptanceRequired !== 'boolean'
      || (claim.proposalClaimRecordHash !== null && !SHA256.test(String(claim.proposalClaimRecordHash || '')))
      || !String(claim.manuscriptPath || '') || !SHA256.test(String(claim.manuscriptFileHash || ''))
      || !Number.isSafeInteger(claim.markerByteStart) || !Number.isSafeInteger(claim.markerByteEnd)
      || !Number.isSafeInteger(claim.manuscriptByteStart) || !Number.isSafeInteger(claim.manuscriptByteEnd)
      || claim.markerByteStart < 0 || claim.manuscriptByteStart <= claim.markerByteStart
      || claim.manuscriptByteEnd <= claim.manuscriptByteStart || claim.markerByteEnd <= claim.manuscriptByteEnd
      || !SHA256.test(String(claim.manuscriptContentHash || '')) || !String(claim.text || '').trim()
      || hashBytes(Buffer.from(claim.text, 'utf8')) !== claim.manuscriptContentHash
      || claim.manuscriptClaimHash !== empiricalManuscriptClaimHash({
        ...claim, manuscriptCorpusHash: universe.manuscriptCorpusHash,
      })) return false;
    const { empiricalClaimUniverseEntryHash, ...entryPayload } = claim;
    if (hashRecord('EmpiricalClaimUniverseEntry', entryPayload) !== empiricalClaimUniverseEntryHash) return false;
    ids.add(claim.claimId);
  }
  const canonicalFiles = [...universe.files].sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(canonicalFiles) !== JSON.stringify(universe.files)
    || canonicalFiles.some((file) => !String(file?.path || '') || !SHA256.test(String(file?.hash || ''))
      || !Number.isSafeInteger(file?.bytes) || file.bytes < 0)
    || hashRecord('EmpiricalManuscriptSourceCorpus', canonicalFiles) !== universe.sourceCorpusHash) return false;
  const filesByPath = new Map(universe.files.map((file) => [file.path, file]));
  if (universe.claims.some((claim) => filesByPath.get(claim.manuscriptPath)?.hash
    !== claim.manuscriptFileHash)) return false;
  const claimCorpus = universe.claims.map((claim) => ({
    claimId: claim.claimId,
    metric: claim.metric,
    comparator: claim.comparator,
    alternative: claim.alternative,
    minimumEffect: claim.minimumEffect,
    acceptanceRequired: claim.acceptanceRequired,
    proposalClaimRecordHash: claim.proposalClaimRecordHash,
    manuscriptPath: claim.manuscriptPath,
    manuscriptContentHash: claim.manuscriptContentHash,
  }));
  if (hashRecord('EmpiricalManuscriptClaimCorpus', claimCorpus) !== universe.manuscriptCorpusHash) return false;
  const authorityPayload = {
    version: 1,
    kind: 'EmpiricalClaimUniverseAuthority',
    manuscriptPath: universe.manuscriptPath,
    manuscriptCorpusHash: universe.manuscriptCorpusHash,
    claimIdentities: universe.claims.map((claim) => ({
      claimId: claim.claimId,
      manuscriptClaimHash: claim.manuscriptClaimHash,
      proposalClaimRecordHash: claim.proposalClaimRecordHash,
    })),
  };
  if (hashRecord('EmpiricalClaimUniverseAuthority', authorityPayload) !== universe.empiricalClaimUniverseHash) return false;
  const { empiricalClaimUniverseReceiptHash, ...payload } = universe;
  return hashRecord('EmpiricalClaimUniverseReceipt', payload) === empiricalClaimUniverseReceiptHash;
}

export function empiricalClaimBindingsFromUniverse(universe) {
  if (!verifyEmpiricalClaimUniverse(universe)) throw new Error('empirical_claim_universe_invalid');
  return Object.freeze(universe.claims.map((claim) => Object.freeze({
    claimId: claim.claimId,
    manuscriptClaimHash: claim.manuscriptClaimHash,
    proposalClaimRecordHash: claim.proposalClaimRecordHash,
    metric: claim.metric,
    comparator: claim.comparator,
    alternative: claim.alternative,
    minimumEffect: claim.minimumEffect,
    acceptanceRequired: claim.acceptanceRequired,
  })));
}
