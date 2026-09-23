import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { dynamicFormalLeanTypeSourceValid } from './dynamic-formal-claim-seed-contract.mjs';
import { leanTypeIdentity } from './lean-type-identity.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/i;
const MAX_CLAIMS = 128;

function requiredText(value, label, maximum = 8_000) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) throw new Error(`theorem_specification_${label}_required`);
  if (text.length > maximum) throw new Error(`theorem_specification_${label}_too_large`);
  if (/\b(?:TODO|TBD|FIXME)\b/i.test(text)) throw new Error(`theorem_specification_${label}_unresolved`);
  return text;
}

function textArray(value, label, { minimum = 0, maximum = 64 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`theorem_specification_${label}_invalid`);
  }
  const normalized = value.map((item) => requiredText(item, label, 2_000));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`theorem_specification_${label}_duplicate`);
  }
  return Object.freeze(normalized);
}

function exactTextArray(value, label, { minimum = 1, maximum = 64 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`theorem_specification_${label}_invalid`);
  }
  const result = value.map((item) => {
    const text = String(item ?? '');
    if (!text.trim() || text.length > 2_000) throw new Error(`theorem_specification_${label}_invalid`);
    return text;
  });
  if (new Set(result).size !== result.length) throw new Error(`theorem_specification_${label}_duplicate`);
  return Object.freeze(result);
}

function dependencyClaimKeys(value) {
  const values = textArray(value || [], 'claim_proof_dependencies', { maximum: MAX_CLAIMS });
  if (values.some((item) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(item))) {
    throw new Error('theorem_specification_claim_proof_dependency_key_invalid');
  }
  return values;
}

export function createProofObligationContracts({ claimKey, proofObligations } = {}) {
  const key = requiredText(claimKey, 'claim_key', 200);
  const displays = textArray(proofObligations, 'claim_proof_obligations', { minimum: 1 });
  return Object.freeze(displays.map((displayText, index) => Object.freeze({
    obligationId: `obligation:${hashRecord('TheoremProofObligationIdentity', {
      version: 1,
      claimKey: key,
      ordinal: index + 1,
      displayText,
    }).slice('sha256:'.length)}`,
    displayText,
  })));
}

function manuscriptSource(value) {
  const byteStart = Number(value?.byteStart);
  const byteEnd = Number(value?.byteEnd);
  if (!value?.path || !Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) || byteEnd <= byteStart
    || !SHA256.test(String(value?.contentHash || '')) || !SHA256.test(String(value?.formalClaimUniverseEntryHash || ''))) {
    throw new Error('theorem_specification_manuscript_source_invalid');
  }
  return Object.freeze({
    path: requiredText(value.path, 'manuscript_source_path', 1_000),
    byteStart,
    byteEnd,
    contentHash: String(value.contentHash).toLowerCase(),
    formalClaimUniverseEntryHash: String(value.formalClaimUniverseEntryHash).toLowerCase(),
  });
}

function proposalClaimSource(value) {
  if (value === null || value === undefined) return null;
  const exactProposalClaimText = String(value?.proposalClaimText ?? '');
  if (!exactProposalClaimText.trim() || exactProposalClaimText.length > 8_000) {
    throw new Error('theorem_specification_proposal_claim_text_invalid');
  }
  const dynamicFormal = Boolean(value?.dynamicFormalClaimSeedHash);
  const source = {
    claimAuthorityType: requiredText(value?.claimAuthorityType, 'proposal_claim_authority_type', 100),
    claimAuthorityBindingHash: String(value?.claimAuthorityBindingHash || '').toLowerCase(),
    claimAuthorityBundleHash: String(value?.claimAuthorityBundleHash || '').toLowerCase(),
    proposalClaimId: requiredText(value?.proposalClaimId, 'proposal_claim_id', 500),
    proposalClaimText: exactProposalClaimText,
    scientificClaimKey: requiredText(value?.scientificClaimKey, 'proposal_scientific_claim_key', 128),
    assumptions: exactTextArray(value?.assumptions, 'proposal_claim_assumptions'),
    quantifiers: exactTextArray(value?.quantifiers, 'proposal_claim_quantifiers'),
    negativeBoundaries: exactTextArray(value?.negativeBoundaries, 'proposal_claim_negative_boundaries'),
    proofObligations: exactTextArray(value?.proofObligations, 'proposal_claim_proof_obligations'),
    proposalClaimTextHash: String(value?.proposalClaimTextHash || '').toLowerCase(),
    proposalClaimRecordHash: String(value?.proposalClaimRecordHash || '').toLowerCase(),
    proposalSeedContractBundleHash: value?.proposalSeedContractBundleHash
      ? String(value.proposalSeedContractBundleHash).toLowerCase() : null,
    approvedProposalSeedBindingHash: value?.approvedProposalSeedBindingHash
      ? String(value.approvedProposalSeedBindingHash).toLowerCase() : null,
    ...(dynamicFormal ? {
      dynamicFormalClaimSeedHash: String(value.dynamicFormalClaimSeedHash || '').toLowerCase(),
      leanDeclarationName: requiredText(value.leanDeclarationName, 'proposal_lean_declaration_name', 160),
      leanTypeSource: String(value.leanTypeSource || '').trim(),
      leanTypeSourceHash: String(value.leanTypeSourceHash || '').toLowerCase(),
      leanNormalizedTypeHash: String(value.leanNormalizedTypeHash || '').toLowerCase(),
      allowedImports: exactTextArray(value.allowedImports, 'proposal_allowed_imports'),
      formalClaimCapabilityScopeManifestHash: String(
        value.formalClaimCapabilityScopeManifestHash || '',
      ).toLowerCase(),
      formalClaimGeneratorReceiptHash: String(
        value.formalClaimGeneratorReceiptHash || '',
      ).toLowerCase(),
    } : {}),
  };
  if (!['operator-signed', 'machine-policy-authorized'].includes(source.claimAuthorityType)
    || ![source.claimAuthorityBindingHash, source.claimAuthorityBundleHash,
      source.proposalClaimTextHash, source.proposalClaimRecordHash].every((hash) => SHA256.test(hash))
    || (source.claimAuthorityType === 'operator-signed'
      && (!SHA256.test(String(source.proposalSeedContractBundleHash || ''))
        || !SHA256.test(String(source.approvedProposalSeedBindingHash || ''))))
    || (source.claimAuthorityType === 'machine-policy-authorized'
      && (source.proposalSeedContractBundleHash !== null
        || source.approvedProposalSeedBindingHash !== null))
    || source.proposalClaimTextHash !== hashBytes(Buffer.from(source.proposalClaimText, 'utf8'))
    || (dynamicFormal && (
      !dynamicFormalLeanTypeSourceValid(source.leanTypeSource)
      || !/^[A-Za-z_][A-Za-z0-9_'.]*$/.test(source.leanDeclarationName)
      || ![
        source.dynamicFormalClaimSeedHash,
        source.leanTypeSourceHash,
        source.leanNormalizedTypeHash,
        source.formalClaimCapabilityScopeManifestHash,
        source.formalClaimGeneratorReceiptHash,
      ].every((hash) => SHA256.test(hash))
      || source.leanTypeSourceHash !== hashBytes(Buffer.from(source.leanTypeSource, 'utf8'))
      || source.leanNormalizedTypeHash
        !== leanTypeIdentity(source.leanTypeSource).normalizedTypeHash
    ))) {
    throw new Error('theorem_specification_proposal_claim_source_invalid');
  }
  return Object.freeze(source);
}

function canonicalClaim(value) {
  const claimKey = requiredText(value?.claimKey, 'claim_key', 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(claimKey)) {
    throw new Error('theorem_specification_claim_key_invalid');
  }
  const assumptions = textArray(value?.assumptions, 'claim_assumptions');
  const quantifiers = textArray(value?.quantifiers, 'claim_quantifiers');
  const negativeBoundaries = textArray(value?.negativeBoundaries, 'claim_negative_boundaries', { minimum: 1 });
  const proofObligations = textArray(value?.proofObligations, 'claim_proof_obligations', { minimum: 1 });
  const obligationContracts = createProofObligationContracts({ claimKey, proofObligations });
  if (value?.proofObligationContracts !== undefined
    && JSON.stringify(value.proofObligationContracts) !== JSON.stringify(obligationContracts)) {
    throw new Error('theorem_specification_proof_obligation_contracts_invalid');
  }
  const payload = {
    version: 1,
    kind: 'TheoremSpecificationClaim',
    claimKey,
    title: requiredText(value?.title, 'claim_title', 500),
    statement: requiredText(value?.statement, 'claim_statement'),
    assumptions,
    quantifiers,
    negativeBoundaries,
    proofObligations,
    proofObligationContracts: obligationContracts,
    proofDependencyClaimKeys: dependencyClaimKeys(value?.proofDependencyClaimKeys),
    evidenceObligations: textArray(value?.evidenceObligations || [], 'claim_evidence_obligations'),
    manuscriptIntent: value?.manuscriptIntent === 'existing' ? 'existing' : 'new',
    releasePolicy: value?.manuscriptIntent === 'existing' ? 'required' : 'optional',
    formalizationTarget: 'lean4',
    manuscriptSource: manuscriptSource(value?.manuscriptSource),
    proposalClaimSource: proposalClaimSource(value?.proposalClaimSource),
  };
  const theoremSpecificationClaimHash = hashRecord('TheoremSpecificationClaim', payload);
  return Object.freeze({
    ...payload,
    claimId: `theorem:${theoremSpecificationClaimHash.slice('sha256:'.length)}`,
    theoremSpecificationClaimHash,
  });
}

export function createTheoremSpecification({
  paperId,
  campaignId,
  sourceManuscriptPath,
  sourceManuscriptHash,
  formalClaimUniverseHash,
  approvedProposalSeedBindingHash = null,
  proposalSeedContractBundleHash = null,
  claimAuthorityType = null,
  claimAuthorityBindingHash = null,
  claimAuthorityBundleHash = null,
  claims,
} = {}) {
  const normalizedClaims = Array.isArray(claims) ? claims.map(canonicalClaim) : [];
  if (!normalizedClaims.length || normalizedClaims.length > MAX_CLAIMS) {
    throw new Error('theorem_specification_claims_invalid');
  }
  const claimKeys = normalizedClaims.map((claim) => claim.claimKey);
  if (new Set(claimKeys).size !== claimKeys.length) throw new Error('theorem_specification_claim_keys_duplicate');
  const claimKeySet = new Set(claimKeys);
  for (const claim of normalizedClaims) {
    if (claim.proofDependencyClaimKeys.includes(claim.claimKey)) {
      throw new Error('theorem_specification_claim_proof_dependency_self_reference');
    }
    if (claim.proofDependencyClaimKeys.some((dependency) => !claimKeySet.has(dependency))) {
      throw new Error('theorem_specification_claim_proof_dependency_missing');
    }
  }
  const visitState = new Map();
  const byKey = new Map(normalizedClaims.map((claim) => [claim.claimKey, claim]));
  const visit = (claimKey) => {
    if (visitState.get(claimKey) === 'visiting') {
      throw new Error('theorem_specification_claim_proof_dependency_cycle');
    }
    if (visitState.get(claimKey) === 'visited') return;
    visitState.set(claimKey, 'visiting');
    for (const dependency of byKey.get(claimKey).proofDependencyClaimKeys) visit(dependency);
    visitState.set(claimKey, 'visited');
  };
  for (const claimKey of claimKeys) visit(claimKey);
  if (!SHA256.test(String(sourceManuscriptHash || ''))) {
    throw new Error('theorem_specification_source_manuscript_hash_invalid');
  }
  if (!SHA256.test(String(formalClaimUniverseHash || ''))) {
    throw new Error('theorem_specification_formal_claim_universe_hash_invalid');
  }
  const lineageRequired = claimAuthorityType !== null
    || claimAuthorityBindingHash !== null
    || claimAuthorityBundleHash !== null
    || approvedProposalSeedBindingHash !== null
    || proposalSeedContractBundleHash !== null
    || normalizedClaims.some((claim) => claim.proposalClaimSource !== null);
  const authorityValid = !lineageRequired || (
    ['operator-signed', 'machine-policy-authorized'].includes(claimAuthorityType)
    && SHA256.test(String(claimAuthorityBindingHash || ''))
    && SHA256.test(String(claimAuthorityBundleHash || ''))
    && (claimAuthorityType === 'operator-signed'
      ? SHA256.test(String(approvedProposalSeedBindingHash || ''))
        && SHA256.test(String(proposalSeedContractBundleHash || ''))
        && approvedProposalSeedBindingHash === claimAuthorityBindingHash
        && proposalSeedContractBundleHash === claimAuthorityBundleHash
      : approvedProposalSeedBindingHash === null && proposalSeedContractBundleHash === null)
    && normalizedClaims.every((claim) => claim.proposalClaimSource
      && claim.proposalClaimSource.claimAuthorityType === claimAuthorityType
      && claim.proposalClaimSource.claimAuthorityBindingHash === claimAuthorityBindingHash
      && claim.proposalClaimSource.claimAuthorityBundleHash === claimAuthorityBundleHash
      && claim.proposalClaimSource.approvedProposalSeedBindingHash === approvedProposalSeedBindingHash
      && claim.proposalClaimSource.proposalSeedContractBundleHash === proposalSeedContractBundleHash)
  );
  if (!authorityValid) {
    throw new Error('theorem_specification_proposal_claim_lineage_invalid');
  }
  const proposalClaimIds = normalizedClaims
    .map((claim) => claim.proposalClaimSource?.proposalClaimId)
    .filter(Boolean);
  if (new Set(proposalClaimIds).size !== proposalClaimIds.length) {
    throw new Error('theorem_specification_proposal_claim_ids_duplicate');
  }
  const payload = {
    version: 1,
    kind: 'TheoremSpecification',
    status: 'theorem_specification_verified',
    paperId: requiredText(paperId, 'paper_id', 500),
    campaignId: requiredText(campaignId, 'campaign_id', 500),
    sourceManuscriptPath: requiredText(sourceManuscriptPath, 'source_manuscript_path', 1_000),
    sourceManuscriptHash,
    formalClaimUniverseHash,
    proposalClaimLineageRequired: lineageRequired,
    claimAuthorityType: lineageRequired ? claimAuthorityType : null,
    claimAuthorityBindingHash: lineageRequired ? claimAuthorityBindingHash : null,
    claimAuthorityBundleHash: lineageRequired ? claimAuthorityBundleHash : null,
    approvedProposalSeedBindingHash: lineageRequired ? approvedProposalSeedBindingHash : null,
    proposalSeedContractBundleHash: lineageRequired ? proposalSeedContractBundleHash : null,
    claimCount: normalizedClaims.length,
    claims: Object.freeze(normalizedClaims),
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    theoremSpecificationHash: hashRecord('TheoremSpecification', payload),
  });
}

export function verifyTheoremSpecification(record, expected = {}) {
  const blockers = [];
  let rebuilt = null;
  try {
    rebuilt = createTheoremSpecification({
      paperId: record?.paperId,
      campaignId: record?.campaignId,
      sourceManuscriptPath: record?.sourceManuscriptPath,
      sourceManuscriptHash: record?.sourceManuscriptHash,
      formalClaimUniverseHash: record?.formalClaimUniverseHash,
      approvedProposalSeedBindingHash: record?.approvedProposalSeedBindingHash,
      proposalSeedContractBundleHash: record?.proposalSeedContractBundleHash,
      claimAuthorityType: record?.claimAuthorityType,
      claimAuthorityBindingHash: record?.claimAuthorityBindingHash,
      claimAuthorityBundleHash: record?.claimAuthorityBundleHash,
      claims: record?.claims,
    });
  } catch (error) {
    blockers.push(error?.message || 'theorem_specification_invalid');
  }
  if (rebuilt) {
    if (record?.theoremSpecificationHash !== rebuilt.theoremSpecificationHash) blockers.push('theorem_specification_hash_mismatch');
    if (record?.status !== rebuilt.status || Number(record?.claimCount) !== rebuilt.claimCount) blockers.push('theorem_specification_summary_mismatch');
    if (record?.proposalClaimLineageRequired !== rebuilt.proposalClaimLineageRequired) blockers.push('theorem_specification_proposal_lineage_summary_mismatch');
    if (JSON.stringify(record?.claims) !== JSON.stringify(rebuilt.claims)) blockers.push('theorem_specification_claims_not_canonical');
  }
  if (expected.paperId && record?.paperId !== expected.paperId) blockers.push('theorem_specification_paper_mismatch');
  if (expected.campaignId && record?.campaignId !== expected.campaignId) blockers.push('theorem_specification_campaign_mismatch');
  if (expected.sourceManuscriptHash && record?.sourceManuscriptHash !== expected.sourceManuscriptHash) blockers.push('theorem_specification_manuscript_mismatch');
  if (expected.formalClaimUniverseHash && record?.formalClaimUniverseHash !== expected.formalClaimUniverseHash) blockers.push('theorem_specification_claim_universe_mismatch');
  if (expected.approvedProposalSeedBindingHash
    && record?.approvedProposalSeedBindingHash !== expected.approvedProposalSeedBindingHash) {
    blockers.push('theorem_specification_approved_proposal_seed_mismatch');
  }
  if (expected.proposalSeedContractBundleHash
    && record?.proposalSeedContractBundleHash !== expected.proposalSeedContractBundleHash) {
    blockers.push('theorem_specification_proposal_seed_bundle_mismatch');
  }
  for (const field of ['claimAuthorityType', 'claimAuthorityBindingHash', 'claimAuthorityBundleHash']) {
    if (expected[field] && record?.[field] !== expected[field]) {
      blockers.push(`theorem_specification_${field}_mismatch`);
    }
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length ? 'theorem_specification_blocked' : 'theorem_specification_verified',
    theoremSpecificationHash: record?.theoremSpecificationHash || null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
