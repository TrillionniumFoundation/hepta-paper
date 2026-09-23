import fs from 'node:fs';
import path from 'node:path';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { createTheoremSpecification, verifyTheoremSpecification } from '../../paper-domain/research/theorem-specification.mjs';
import {
  proposalClaimSourceFromAuthority,
  verifyScientificClaimLineageAuthority,
} from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { readFormalClaimUniverse } from '../research-verify/formal-claim-universe-reader.mjs';

const DRAFT_PATH = 'THEOREM_SPEC_DRAFT.json';
const SPECIFICATION_PATH = 'THEOREM_SPEC.json';
const DRAFT_KEYS = Object.freeze(['claims', 'kind', 'version']);
const CLAIM_KEYS = Object.freeze([
  'assumptions',
  'claimKey',
  'evidenceObligations',
  'manuscriptIntent',
  'negativeBoundaries',
  'proofObligations',
  'proofDependencyClaimKeys',
  'proposalClaimId',
  'quantifiers',
  'statement',
  'title',
]);
const CLAIM_KEYS_WITHOUT_PROPOSAL = Object.freeze(CLAIM_KEYS.filter((key) => key !== 'proposalClaimId'));
const LEGACY_CLAIM_KEYS = Object.freeze(CLAIM_KEYS.filter((key) => key !== 'proofDependencyClaimKeys'));
const LEGACY_CLAIM_KEYS_WITHOUT_PROPOSAL = Object.freeze(
  LEGACY_CLAIM_KEYS.filter((key) => key !== 'proposalClaimId'),
);
const PROPOSAL_SCOPE_FIELDS = Object.freeze([
  'assumptions',
  'quantifiers',
  'negativeBoundaries',
  'proofObligations',
]);

function exactKeys(value, expected, blocker) {
  if (!hasExactObjectKeys(value, expected)) throw new Error(blocker);
}

function normalizedText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function requireScopedRegularFile(scoped, blocker) {
  let stat;
  let real;
  try {
    stat = fs.lstatSync(scoped.candidate);
    real = fs.realpathSync(scoped.candidate);
  } catch { throw new Error(blocker); }
  if (!stat.isFile() || stat.isSymbolicLink() || !isPathWithin(scoped.root, real)) {
    throw new Error(blocker);
  }
  return real;
}

function proposalSeedRelativePath(binding) {
  return String(binding?.contractPath || '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || null;
}

export function readScientificClaimLineageAuthority({
  workspace,
  scientificClaimAuthority,
  paperId,
} = {}) {
  if (!scientificClaimAuthority) return null;
  const relative = proposalSeedRelativePath(scientificClaimAuthority);
  if (!relative) throw new Error('theorem_specification_proposal_seed_path_required');
  const seedFile = scopedFile(workspace, relative);
  requireScopedRegularFile(seedFile, 'theorem_specification_proposal_seed_required');
  let seedContractBundle;
  try { seedContractBundle = JSON.parse(fs.readFileSync(seedFile.candidate, 'utf8')); }
  catch { throw new Error('theorem_specification_proposal_seed_json_invalid'); }
  const authority = verifyScientificClaimLineageAuthority({
    scientificClaimAuthority,
    seedContractBundle,
    paperId,
  });
  if (!authority.valid) {
    throw new Error(`theorem_specification_proposal_seed_invalid:${authority.blockers.join(',')}`);
  }
  return authority;
}

export function readApprovedProposalSeedLineageAuthority({ workspace, approvedProposalSeed, paperId } = {}) {
  return readScientificClaimLineageAuthority({
    workspace,
    scientificClaimAuthority: approvedProposalSeed,
    paperId,
  });
}

function selectedClaimAuthority(scientificClaimAuthority, approvedProposalSeed) {
  if (scientificClaimAuthority && approvedProposalSeed) {
    throw new Error('theorem_specification_multiple_claim_authorities_forbidden');
  }
  return scientificClaimAuthority || approvedProposalSeed || null;
}

export function readFinalizedTheoremSpecification({
  workspace,
  manuscriptPath,
  paperId,
  campaignId,
  scientificClaimAuthority = null,
  approvedProposalSeed = null,
} = {}) {
  const specificationFile = scopedFile(workspace, SPECIFICATION_PATH);
  requireScopedRegularFile(specificationFile, 'theorem_specification_canonical_required');
  let specification;
  try { specification = JSON.parse(fs.readFileSync(specificationFile.candidate, 'utf8')); }
  catch { throw new Error('theorem_specification_canonical_json_invalid'); }
  const formalClaimUniverse = readFormalClaimUniverse({ sourceRoot: specificationFile.root, manuscriptPath });
  if (formalClaimUniverse.status !== 'formal_claim_universe_verified') {
    throw new Error(`theorem_specification_claim_universe_invalid:${formalClaimUniverse.blockers.join(',')}`);
  }
  const verification = verifyTheoremSpecification(specification, {
    paperId,
    campaignId,
    sourceManuscriptHash: formalClaimUniverse.manuscriptHash,
    formalClaimUniverseHash: formalClaimUniverse.formalClaimUniverseHash,
  });
  if (!verification.valid) throw new Error(`theorem_specification_canonical_invalid:${verification.blockers.join(',')}`);
  const proposalAuthority = readScientificClaimLineageAuthority({
    workspace,
    scientificClaimAuthority: selectedClaimAuthority(scientificClaimAuthority, approvedProposalSeed),
    paperId,
  });
  if (specification.proposalClaimLineageRequired !== Boolean(proposalAuthority)) {
    throw new Error('theorem_specification_canonical_proposal_lineage_authority_mismatch');
  }
  if (proposalAuthority) {
    if (specification.claimAuthorityType !== proposalAuthority.claimAuthorityType
      || specification.claimAuthorityBindingHash !== proposalAuthority.claimAuthorityBindingHash
      || specification.claimAuthorityBundleHash !== proposalAuthority.claimAuthorityBundleHash
      || specification.approvedProposalSeedBindingHash !== proposalAuthority.approvedProposalSeedBindingHash
      || specification.proposalSeedContractBundleHash !== proposalAuthority.proposalSeedContractBundleHash
      || specification.claims.length !== proposalAuthority.claims.length) {
      throw new Error('theorem_specification_canonical_proposal_lineage_summary_mismatch');
    }
    const proposalById = new Map(proposalAuthority.claims.map((claim) => [claim.proposalClaimId, claim]));
    for (const claim of specification.claims) {
      const source = claim.proposalClaimSource;
      const authoritative = proposalById.get(source?.proposalClaimId);
      if (!authoritative
        || JSON.stringify(source) !== JSON.stringify(proposalClaimSourceFromAuthority(authoritative))) {
        throw new Error(`theorem_specification_canonical_proposal_claim_mismatch:${claim.claimId}`);
      }
    }
  }
  if (specification.sourceManuscriptPath !== manuscriptPath
    || specification.claims.length !== formalClaimUniverse.theorems.length) {
    throw new Error('theorem_specification_canonical_universe_mismatch');
  }
  for (let index = 0; index < specification.claims.length; index += 1) {
    const claim = specification.claims[index];
    const theorem = formalClaimUniverse.theorems[index];
    if (normalizedText(claim.statement) !== normalizedText(theorem.text)
      || claim.manuscriptSource?.path !== theorem.manuscriptPath
      || claim.manuscriptSource?.byteStart !== theorem.manuscriptByteStart
      || claim.manuscriptSource?.byteEnd !== theorem.manuscriptByteEnd
      || claim.manuscriptSource?.contentHash !== theorem.manuscriptContentHash
      || claim.manuscriptSource?.formalClaimUniverseEntryHash !== theorem.formalClaimUniverseEntryHash) {
      throw new Error(`theorem_specification_canonical_claim_mismatch:${index + 1}`);
    }
  }
  return Object.freeze(specification);
}

function scopedFile(workspace, relative) {
  const root = fs.realpathSync(workspace);
  const candidate = path.resolve(root, relative);
  if (candidate === root || !isPathWithin(root, candidate)) throw new Error('theorem_specification_path_escape');
  return { root, candidate };
}

export function finalizeTheoremSpecification({
  workspace,
  manuscriptPath,
  paperId,
  campaignId,
  scientificClaimAuthority = null,
  approvedProposalSeed = null,
} = {}) {
  const draftFile = scopedFile(workspace, DRAFT_PATH);
  const manuscriptFile = scopedFile(workspace, manuscriptPath);
  const specificationFile = scopedFile(workspace, SPECIFICATION_PATH);
  requireScopedRegularFile(draftFile, 'theorem_specification_draft_required');
  requireScopedRegularFile(manuscriptFile, 'theorem_specification_manuscript_required');
  if (fs.existsSync(specificationFile.candidate)) {
    requireScopedRegularFile(specificationFile, 'theorem_specification_canonical_path_invalid');
  }
  let draft;
  const draftBytes = fs.readFileSync(draftFile.candidate);
  try { draft = JSON.parse(draftBytes.toString('utf8')); }
  catch { throw new Error('theorem_specification_draft_json_invalid'); }
  exactKeys(draft, DRAFT_KEYS, 'theorem_specification_draft_schema_invalid');
  if (draft?.version !== 1 || draft?.kind !== 'TheoremSpecificationDraft' || !Array.isArray(draft?.claims)) {
    throw new Error('theorem_specification_draft_shape_invalid');
  }
  const proposalAuthority = readScientificClaimLineageAuthority({
    workspace,
    scientificClaimAuthority: selectedClaimAuthority(scientificClaimAuthority, approvedProposalSeed),
    paperId,
  });
  for (const claim of draft.claims) {
    const expected = proposalAuthority ? CLAIM_KEYS : CLAIM_KEYS_WITHOUT_PROPOSAL;
    const legacy = proposalAuthority ? LEGACY_CLAIM_KEYS : LEGACY_CLAIM_KEYS_WITHOUT_PROPOSAL;
    if (!hasExactObjectKeys(claim, expected) && !hasExactObjectKeys(claim, legacy)) {
      throw new Error('theorem_specification_draft_claim_schema_invalid');
    }
  }
  const formalClaimUniverse = readFormalClaimUniverse({ sourceRoot: draftFile.root, manuscriptPath });
  if (formalClaimUniverse.status !== 'formal_claim_universe_verified') {
    throw new Error(`theorem_specification_claim_universe_invalid:${formalClaimUniverse.blockers.join(',')}`);
  }
  if (draft.claims.length !== formalClaimUniverse.theorems.length) {
    throw new Error('theorem_specification_claim_universe_count_mismatch');
  }
  if (proposalAuthority && draft.claims.length !== proposalAuthority.claims.length) {
    throw new Error('theorem_specification_proposal_claim_count_mismatch');
  }
  const proposalById = new Map((proposalAuthority?.claims || [])
    .map((claim) => [claim.proposalClaimId, claim]));
  const selectedProposalClaimIds = draft.claims.map((claim) => claim.proposalClaimId).filter(Boolean);
  if (proposalAuthority && (selectedProposalClaimIds.length !== draft.claims.length
    || new Set(selectedProposalClaimIds).size !== selectedProposalClaimIds.length
    || selectedProposalClaimIds.some((claimId) => !proposalById.has(claimId)))) {
    throw new Error('theorem_specification_proposal_claim_mapping_invalid');
  }
  const authoritativeClaimKeyByDraftKey = new Map(draft.claims.map((claim) => [
    claim.claimKey,
    proposalAuthority
      ? proposalById.get(claim.proposalClaimId)?.scientificClaimKey
      : claim.claimKey,
  ]));
  const claims = draft.claims.map((claim, index) => {
    const { proposalClaimId, ...draftClaim } = claim;
    const theorem = formalClaimUniverse.theorems[index];
    if (normalizedText(claim.statement) !== normalizedText(theorem.text)) {
      throw new Error(`theorem_specification_claim_statement_mismatch:${index + 1}`);
    }
    const authoritativeProposalClaim = proposalAuthority ? proposalById.get(proposalClaimId) : null;
    return {
      ...draftClaim,
      proofDependencyClaimKeys: (draftClaim.proofDependencyClaimKeys || [])
        .map((claimKey) => authoritativeClaimKeyByDraftKey.get(claimKey) || claimKey),
      ...(proposalAuthority ? {
        claimKey: authoritativeProposalClaim.scientificClaimKey,
        ...Object.fromEntries(PROPOSAL_SCOPE_FIELDS.map((field) => [
          field,
          authoritativeProposalClaim[field],
        ])),
        proposalClaimSource: proposalClaimSourceFromAuthority(authoritativeProposalClaim),
      } : {}),
      statement: theorem.text,
      manuscriptIntent: 'existing',
      manuscriptSource: {
        path: theorem.manuscriptPath,
        byteStart: theorem.manuscriptByteStart,
        byteEnd: theorem.manuscriptByteEnd,
        contentHash: theorem.manuscriptContentHash,
        formalClaimUniverseEntryHash: theorem.formalClaimUniverseEntryHash,
      },
    };
  });
  const specification = createTheoremSpecification({
    paperId,
    campaignId,
    sourceManuscriptPath: manuscriptPath,
    sourceManuscriptHash: formalClaimUniverse.manuscriptHash,
    formalClaimUniverseHash: formalClaimUniverse.formalClaimUniverseHash,
    approvedProposalSeedBindingHash: proposalAuthority?.approvedProposalSeedBindingHash || null,
    proposalSeedContractBundleHash: proposalAuthority?.proposalSeedContractBundleHash || null,
    claimAuthorityType: proposalAuthority?.claimAuthorityType || null,
    claimAuthorityBindingHash: proposalAuthority?.claimAuthorityBindingHash || null,
    claimAuthorityBundleHash: proposalAuthority?.claimAuthorityBundleHash || null,
    claims,
  });
  const verification = verifyTheoremSpecification(specification, {
    paperId,
    campaignId,
    sourceManuscriptHash: formalClaimUniverse.manuscriptHash,
    formalClaimUniverseHash: formalClaimUniverse.formalClaimUniverseHash,
  });
  if (!verification.valid) throw new Error(`theorem_specification_finalize_blocked:${verification.blockers.join(',')}`);
  writeDurableJsonSync(specificationFile.candidate, specification);
  fs.rmSync(draftFile.candidate, { force: true });
  const payload = {
    version: 1,
    kind: 'TheoremSpecificationFinalizationReceipt',
    status: 'theorem_specification_finalized',
    paperId,
    campaignId,
    manuscriptPath,
    sourceManuscriptHash: specification.sourceManuscriptHash,
    draftHash: hashBytes(draftBytes),
    theoremSpecificationPath: SPECIFICATION_PATH,
    theoremSpecificationHash: specification.theoremSpecificationHash,
    approvedProposalSeedBindingHash: specification.approvedProposalSeedBindingHash,
    proposalSeedContractBundleHash: specification.proposalSeedContractBundleHash,
    claimAuthorityType: specification.claimAuthorityType,
    claimAuthorityBindingHash: specification.claimAuthorityBindingHash,
    claimAuthorityBundleHash: specification.claimAuthorityBundleHash,
    proposalClaimRecordHashes: Object.freeze(specification.claims
      .map((claim) => claim.proposalClaimSource?.proposalClaimRecordHash).filter(Boolean)),
    claimCount: specification.claimCount,
    blockers: Object.freeze([]),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    theoremSpecificationFinalizationReceiptHash: hashRecord('TheoremSpecificationFinalizationReceipt', payload),
  });
}
