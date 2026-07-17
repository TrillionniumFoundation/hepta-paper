import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { manuscriptClaimHash } from './formal-claim-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

const TRANSITIONS = Object.freeze({
  candidate: new Set(['supported', 'rejected', 'superseded']),
  supported: new Set(['superseded']),
  rejected: new Set([]),
  superseded: new Set([]),
});

function cycleFor(records) {
  const byId = new Map(records.map((claim) => [claim.claimId, claim]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id, stack) => {
    if (visiting.has(id)) return [...stack, id];
    if (visited.has(id)) return null;
    visiting.add(id);
    const claim = byId.get(id);
    for (const dependencyId of claim?.dependencyIds || []) {
      const cycle = visit(dependencyId, [...stack, id]);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of byId.keys()) {
    const cycle = visit(id, []);
    if (cycle) return cycle;
  }
  return null;
}

export function buildClaimRegistry({ paperTask, claims = [] } = {}) {
  const records = claims.map((claim, index) => {
    const claimId = String(claim.id || claim.claimId || `claim-${index + 1}`);
    const text = String(claim.text || claim.summary || '');
    const sourceLocator = claim.sourceLocator || claim.source_locator || null;
    const claimKind = claim.claimKind || claim.kind || 'research_claim';
    const empiricalCanonical = claimKind === 'empirical_claim'
      && SHA256.test(String(claim.empiricalClaimUniverseEntryHash || ''))
      && SHA256.test(String(claim.empiricalClaimUniverseHash || ''))
      && SHA256.test(String(claim.manuscriptCorpusHash || ''))
      && SHA256.test(String(claim.manuscriptClaimHash || ''));
    return {
    claimId,
    text,
    sourceLocator,
    manuscriptClaimHash: empiricalCanonical
      ? claim.manuscriptClaimHash : manuscriptClaimHash({ claimId, text, sourceLocator }),
    status: claim.status || 'candidate',
    version: Math.max(1, Number(claim.version || 1)),
    dependencyIds: Array.isArray(claim.dependencyIds) ? [...claim.dependencyIds].map(String).sort() : [],
    claimKind,
    manuscriptPath: claim.manuscriptPath || null,
    manuscriptByteStart: Number.isSafeInteger(claim.manuscriptByteStart) ? claim.manuscriptByteStart : null,
    manuscriptByteEnd: Number.isSafeInteger(claim.manuscriptByteEnd) ? claim.manuscriptByteEnd : null,
    manuscriptContentHash: claim.manuscriptContentHash || null,
    manuscriptFileHash: claim.manuscriptFileHash || null,
    empiricalClaimUniverseEntryHash: empiricalCanonical ? claim.empiricalClaimUniverseEntryHash : null,
    empiricalClaimUniverseHash: empiricalCanonical ? claim.empiricalClaimUniverseHash : null,
    manuscriptCorpusHash: empiricalCanonical ? claim.manuscriptCorpusHash : null,
    proposalClaimRecordHash: empiricalCanonical ? (claim.proposalClaimRecordHash || null) : null,
    riskClass: claim.riskClass || claim.risk_class || '',
    proofObligations: Array.isArray(claim.proofObligations || claim.proof_obligations) ? [...(claim.proofObligations || claim.proof_obligations)].map(String).sort() : [],
    verificationPlan: claim.verificationPlan || claim.verification_plan || null,
    negativeResultPolicy: claim.negativeResultPolicy || claim.negative_result_policy || 'preserve_and_do_not_promote_without_explicit_acceptance',
  };
  });
  const ids = records.map((claim) => claim.claimId);
  const idSet = new Set(ids);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  const missingDependencies = records.flatMap((claim) => claim.dependencyIds
    .filter((dependencyId) => !idSet.has(dependencyId))
    .map((dependencyId) => ({ claimId: claim.claimId, dependencyId })));
  const cycle = duplicateIds.length || missingDependencies.length ? null : cycleFor(records);
  const blockers = [
    ...(!records.length ? ['claim_registry_empty'] : []),
    ...[...new Set(duplicateIds)].map((id) => `duplicate_claim_id:${id}`),
    ...missingDependencies.map(({ claimId, dependencyId }) => `missing_claim_dependency:${claimId}:${dependencyId}`),
    ...(cycle ? [`claim_dependency_cycle:${cycle.join('>')}`] : []),
    ...records.filter((claim) => claim.claimKind === 'formal_claim' && (
      !claim.manuscriptPath
      || claim.manuscriptByteStart === null
      || claim.manuscriptByteEnd === null
      || !claim.manuscriptContentHash
      || !claim.manuscriptFileHash
    )).map((claim) => `formal_claim_canonical_manuscript_binding_missing:${claim.claimId}`),
    ...records.filter((claim) => claim.claimKind === 'empirical_claim' && (
      !claim.manuscriptPath
      || claim.manuscriptByteStart === null
      || claim.manuscriptByteEnd === null
      || !claim.manuscriptContentHash
      || !claim.manuscriptFileHash
      || !claim.empiricalClaimUniverseEntryHash
      || !claim.empiricalClaimUniverseHash
      || !claim.manuscriptCorpusHash
    )).map((claim) => `empirical_claim_canonical_manuscript_binding_missing:${claim.claimId}`),
  ];
  const record = {
    version: 2,
    kind: 'ClaimRegistry',
    paperId: paperTask?.paperId || null,
    status: blockers.length ? 'claim_graph_blocked' : 'claim_graph_valid',
    claims: records,
    blockers,
  };
  return { ...record, claimRegistryHash: hashRecord('ClaimRegistry', record) };
}

export function transitionClaim(registry, { claimId, toStatus, expectedVersion = null } = {}) {
  if (registry?.status !== 'claim_graph_valid') throw new Error('Claim graph must be valid before transition');
  const index = registry.claims.findIndex((claim) => claim.claimId === String(claimId));
  if (index < 0) throw new Error(`Unknown claim: ${claimId}`);
  const current = registry.claims[index];
  const currentVersion = Number(current.version || 1);
  if (expectedVersion !== null && Number(expectedVersion) !== currentVersion) throw new Error('Claim version conflict');
  if (!TRANSITIONS[current.status]?.has(String(toStatus))) {
    throw new Error(`Invalid claim transition: ${current.status}->${toStatus}`);
  }
  const claims = registry.claims.map((claim, claimIndex) => claimIndex === index
    ? { ...claim, status: String(toStatus), version: currentVersion + 1 }
    : claim);
  const nextRegistry = buildClaimRegistry({ paperTask: { paperId: registry.paperId }, claims: claims.map((claim) => ({
    ...claim,
    id: claim.claimId,
  })) });
  const receiptPayload = {
    version: 1,
    kind: 'ClaimTransitionReceipt',
    paperId: registry.paperId,
    claimId: current.claimId,
    fromStatus: current.status,
    toStatus: String(toStatus),
    priorVersion: currentVersion,
    nextVersion: currentVersion + 1,
    priorRegistryHash: registry.claimRegistryHash,
    nextRegistryHash: nextRegistry.claimRegistryHash,
    status: 'claim_transition_recorded',
  };
  return {
    ...nextRegistry,
    transitionReceipt: {
      ...receiptPayload,
      claimTransitionReceiptHash: hashRecord('ClaimTransitionReceipt', receiptPayload),
    },
  };
}
