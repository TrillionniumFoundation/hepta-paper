import { hashPaperRecord } from '../contracts/primitives.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY,
  selectAutonomousFormalSupportTemplate,
} from '../automation/autonomous-formal-support-registry.mjs';
import {
  dynamicFormalLeanTypeSourceValid,
  verifyDynamicFormalClaimSeed,
} from './dynamic-formal-claim-seed-contract.mjs';
import { leanTypeIdentity } from './lean-type-identity.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/i;
const RELATIONS = new Set(['equivalent']);
const SCIENTIFIC_SCOPE_FIELDS = Object.freeze([
  'assumptions',
  'quantifiers',
  'negativeBoundaries',
  'proofObligations',
]);

function requiredText(value, blocker, maximum = 8_000) {
  const text = String(value ?? '');
  if (!text.trim() || text.length > maximum) throw new Error(blocker);
  return text;
}

function requiredTextList(value, blocker) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error(blocker);
  const result = value.map((item) => requiredText(item, blocker, 2_000));
  if (new Set(result).size !== result.length) throw new Error(blocker);
  return Object.freeze(result);
}

function normalizedComparisonOperand(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[-_]/g, ' ')
    .replace(/\b(?:the|reported|protocol|evaluation|cell|cells|count|number|of)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '');
}

function lessThanOrEqualComparisons(value) {
  const text = String(value || '').replace(/[-_]/g, ' ');
  const patterns = [
    /([A-Za-z][A-Za-z0-9 ]{0,80}?)\s+(?:is\s+)?at most\s+([A-Za-z][A-Za-z0-9 ]{0,80}?)(?=[,.;]|\bthen\b|$)/gi,
    /([A-Za-z][A-Za-z0-9 ]{0,80}?)\s+(?:does not|do not|cannot)\s+exceed\s+([A-Za-z][A-Za-z0-9 ]{0,80}?)(?=[,.;]|$)/gi,
    /([A-Za-z][A-Za-z0-9 ]{0,80}?)\s+is bounded by\s+([A-Za-z][A-Za-z0-9 ]{0,80}?)(?=[,.;]|$)/gi,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => (
    `${normalizedComparisonOperand(match[1])}<=${normalizedComparisonOperand(match[2])}`
  ))).filter((comparison) => !comparison.startsWith('<=') && !comparison.endsWith('<='));
}

function machineFormalClaimCircular(raw) {
  const statementComparisons = lessThanOrEqualComparisons(raw?.text);
  const assumptionComparisons = (raw?.assumptions || []).flatMap(lessThanOrEqualComparisons);
  if (statementComparisons.some((comparison) => assumptionComparisons.includes(comparison))) return true;
  const match = String(raw?.text || '').match(/\bif\b([\s\S]+?)\bthen\b([\s\S]+)/i);
  if (!match) return false;
  const premise = lessThanOrEqualComparisons(match[1]);
  const conclusion = lessThanOrEqualComparisons(match[2]);
  return premise.some((comparison) => conclusion.includes(comparison));
}

function bindingPayload(binding) {
  return {
    version: binding?.version,
    kind: binding?.kind,
    status: binding?.status,
    contractPath: binding?.contractPath,
    proposalEnvelopeHash: binding?.proposalEnvelopeHash,
    productionPlanEnvelopeHash: binding?.productionPlanEnvelopeHash,
    reviewGateHash: binding?.reviewGateHash,
    proposalSeedContractBundleHash: binding?.proposalSeedContractBundleHash,
  };
}

export function verifyApprovedProposalSeedLineageAuthority({
  approvedProposalSeed,
  proposalSeedContractBundle,
  paperId,
} = {}) {
  const blockers = [];
  const binding = approvedProposalSeed || {};
  const bundle = proposalSeedContractBundle || {};
  if (binding.version !== 1 || binding.kind !== 'ApprovedProposalSeedBinding'
    || binding.status !== 'approved_proposal_seed_bound'
    || !binding.approvedProposalSeedBindingHash
    || hashRecord('ApprovedProposalSeedBinding', bindingPayload(binding))
      !== binding.approvedProposalSeedBindingHash) {
    blockers.push('proposal_theorem_approved_seed_binding_invalid');
  }
  const { paperProposalSeedContractBundleHash: claimedBundleHash, ...bundlePayload } = bundle;
  if (bundle.version !== 1 || bundle.kind !== 'PaperProposalSeedContractBundle'
    || bundle.status !== 'proposal_seed_contracts_ready'
    || !claimedBundleHash
    || hashPaperRecord('PaperProposalSeedContractBundle', bundlePayload) !== claimedBundleHash
    || claimedBundleHash !== binding.proposalSeedContractBundleHash) {
    blockers.push('proposal_theorem_seed_bundle_invalid');
  }
  if (paperId && bundle.paperId !== paperId) blockers.push('proposal_theorem_seed_paper_mismatch');
  for (const field of ['proposalEnvelopeHash', 'productionPlanEnvelopeHash', 'reviewGateHash']) {
    if (!binding[field] || bundle[field] !== binding[field]) {
      blockers.push(`proposal_theorem_seed_${field}_mismatch`);
    }
  }
  const rawClaims = Array.isArray(bundle.claims) ? bundle.claims : [];
  if (!rawClaims.length || rawClaims.length > 128) blockers.push('proposal_theorem_seed_claims_invalid');
  const claims = [];
  for (let index = 0; index < rawClaims.length; index += 1) {
    const raw = rawClaims[index];
    try {
      const proposalClaimId = requiredText(raw?.id, 'proposal_theorem_seed_claim_id_invalid', 500).trim();
      const proposalClaimText = requiredText(raw?.text, 'proposal_theorem_seed_claim_text_invalid');
      if (raw?.kind !== 'proposal_claim_seed' || raw?.status !== 'proposal_seed') {
        throw new Error('proposal_theorem_seed_claim_status_invalid');
      }
      claims.push(Object.freeze({
        claimAuthorityType: 'operator-signed',
        claimAuthorityBindingHash: binding.approvedProposalSeedBindingHash || null,
        claimAuthorityBundleHash: claimedBundleHash || null,
        proposalClaimId,
        proposalClaimText,
        scientificClaimKey: requiredText(raw?.scientificClaimKey, 'proposal_theorem_seed_scientific_claim_key_invalid', 128).trim(),
        ...Object.fromEntries(SCIENTIFIC_SCOPE_FIELDS.map((field) => [
          field,
          requiredTextList(raw?.[field], `proposal_theorem_seed_${field}_invalid`),
        ])),
        proposalClaimTextHash: hashBytes(Buffer.from(proposalClaimText, 'utf8')),
        proposalClaimRecordHash: hashRecord('ApprovedProposalClaimRecord', raw),
        proposalSeedContractBundleHash: claimedBundleHash || null,
        approvedProposalSeedBindingHash: binding.approvedProposalSeedBindingHash || null,
      }));
    } catch (error) {
      blockers.push(`${error?.message || 'proposal_theorem_seed_claim_invalid'}:${index + 1}`);
    }
  }
  const ids = claims.map((claim) => claim.proposalClaimId);
  if (new Set(ids).size !== ids.length) blockers.push('proposal_theorem_seed_claim_ids_duplicate');
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'approved_proposal_seed_lineage_authority_blocked'
      : 'approved_proposal_seed_lineage_authority_verified',
    approvedProposalSeedBindingHash: binding.approvedProposalSeedBindingHash || null,
    proposalSeedContractBundleHash: claimedBundleHash || null,
    claimAuthorityType: 'operator-signed',
    claimAuthorityBindingHash: binding.approvedProposalSeedBindingHash || null,
    claimAuthorityBundleHash: claimedBundleHash || null,
    claims: Object.freeze(claims),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function verifyAutonomousResearchSeedLineageAuthority({
  scientificClaimAuthority,
  autonomousResearchSeedContractBundle,
  paperId,
} = {}) {
  const blockers = [];
  const binding = scientificClaimAuthority || {};
  const bundle = autonomousResearchSeedContractBundle || {};
  const { autonomousResearchSeedBindingHash: claimedBindingHash, ...bindingPayload } = binding;
  const { autonomousResearchSeedContractBundleHash: claimedBundleHash, ...bundlePayload } = bundle;
  if (binding.version !== 1 || binding.kind !== 'AutonomousResearchSeedBinding'
    || binding.status !== 'autonomous_research_seed_bound'
    || binding.claimAuthorityType !== 'machine-policy-authorized'
    || !claimedBindingHash
    || hashRecord('AutonomousResearchSeedBinding', bindingPayload) !== claimedBindingHash
    || (binding.blockers || []).length) {
    blockers.push('autonomous_theorem_seed_binding_invalid');
  }
  const dynamicFormal = bundle.version === 2;
  if (![1, 2].includes(bundle.version) || bundle.kind !== 'AutonomousResearchSeedContractBundle'
    || bundle.status !== 'autonomous_research_seed_contracts_ready'
    || bundle.claimAuthorityType !== 'machine-policy-authorized'
    || !claimedBundleHash
    || hashRecord('AutonomousResearchSeedContractBundle', bundlePayload) !== claimedBundleHash
    || claimedBundleHash !== binding.seedBundleHash
    || bundle.proposalHash !== binding.proposalHash
    || bundle.policyAuthorizationHash !== binding.policyAuthorizationHash
    || (bundle.blockers || []).length) {
    blockers.push('autonomous_theorem_seed_bundle_invalid');
  }
  if (paperId && (bundle.paperId !== paperId || binding.paperId !== paperId)) {
    blockers.push('autonomous_theorem_seed_paper_mismatch');
  }
  if (bundle?.safety?.operatorApprovalClaimed !== false
    || bundle?.safety?.externalReleaseAttestationRequired !== true
    || bundle?.safety?.naturalLanguageToLeanEquivalenceMachineProven !== false) {
    blockers.push('autonomous_theorem_seed_safety_invalid');
  }
  const rawClaims = Array.isArray(bundle.claims) ? bundle.claims : [];
  const formalClaims = rawClaims.filter((claim) => claim?.verificationMode === 'formal_kernel');
  if (formalClaims.length !== 1
    || rawClaims.some((claim) => !['formal_kernel', 'empirical_protocol'].includes(claim?.verificationMode))) {
    blockers.push('autonomous_theorem_formal_claims_invalid');
  }
  const formalClaim = formalClaims[0];
  const formalScope = formalClaim ? {
    statement: formalClaim.text,
    assumptions: formalClaim.assumptions,
    quantifiers: formalClaim.quantifiers,
    negativeBoundaries: formalClaim.negativeBoundaries,
    proofObligations: formalClaim.proofObligations,
  } : null;
  if (dynamicFormal) {
    const dynamicVerification = verifyDynamicFormalClaimSeed(bundle?.dynamicFormalClaimSeed, {
      claimKey: formalClaim?.scientificClaimKey,
    });
    if (bundle?.formalSupportMode !== 'dynamic-lean-type-v1'
      || bundle?.dynamicFormalClaimSeedHash
        !== bundle?.dynamicFormalClaimSeed?.dynamicFormalClaimSeedHash
      || bundle?.formalSupportRegistryHash !== null
      || bundle?.formalSupportTemplateId !== null
      || bundle?.formalSupportTemplateHash !== null
      || !dynamicVerification.valid
      || JSON.stringify(formalScope) !== JSON.stringify({
        statement: bundle?.dynamicFormalClaimSeed?.statement,
        assumptions: bundle?.dynamicFormalClaimSeed?.assumptions,
        quantifiers: bundle?.dynamicFormalClaimSeed?.quantifiers,
        negativeBoundaries: bundle?.dynamicFormalClaimSeed?.negativeBoundaries,
        proofObligations: bundle?.dynamicFormalClaimSeed?.proofObligations,
      })
      || formalClaim?.dynamicFormalClaimSeedHash !== bundle?.dynamicFormalClaimSeedHash
      || formalClaim?.leanDeclarationName !== bundle?.dynamicFormalClaimSeed?.leanDeclarationName
      || formalClaim?.leanTypeSource !== bundle?.dynamicFormalClaimSeed?.leanTypeSource
      || formalClaim?.leanTypeSourceHash !== bundle?.dynamicFormalClaimSeed?.leanTypeSourceHash
      || formalClaim?.leanNormalizedTypeHash
        !== bundle?.dynamicFormalClaimSeed?.leanNormalizedTypeHash
      || JSON.stringify(formalClaim?.allowedImports)
        !== JSON.stringify(bundle?.dynamicFormalClaimSeed?.allowedImports)
      || formalClaim?.formalClaimCapabilityScopeManifestHash
        !== bundle?.dynamicFormalClaimSeed?.capabilityScopeManifestHash
      || formalClaim?.formalClaimGeneratorReceiptHash
        !== bundle?.dynamicFormalClaimSeed?.generatorReceiptHash) {
      blockers.push('autonomous_theorem_dynamic_formal_lineage_invalid');
    }
  } else {
    let formalTemplate = null;
    try { formalTemplate = selectAutonomousFormalSupportTemplate(bundle?.protocolFamily); }
    catch { blockers.push('autonomous_theorem_formal_template_family_invalid'); }
    if (!formalTemplate
      || bundle?.formalSupportRegistryHash
        !== AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY.autonomousFormalSupportTemplateRegistryHash
      || bundle?.formalSupportTemplateId !== formalTemplate?.templateId
      || bundle?.formalSupportTemplateHash !== formalTemplate?.autonomousFormalSupportTemplateHash
      || JSON.stringify(formalScope) !== JSON.stringify(formalTemplate?.scope)) {
      blockers.push('autonomous_theorem_formal_template_lineage_invalid');
    }
  }
  const claims = [];
  for (let index = 0; index < formalClaims.length; index += 1) {
    const raw = formalClaims[index];
    try {
      if (raw?.kind !== 'machine_proposed_claim_seed'
        || raw?.status !== 'machine_proposed_policy_authorized_for_bounded_execution'
        || !SHA256.test(String(raw?.machineProposedScientificClaimSetHash || ''))
        || !Array.isArray(raw?.empiricalObligations) || raw.empiricalObligations.length !== 0
        || machineFormalClaimCircular(raw)) {
        throw new Error('autonomous_theorem_formal_claim_status_invalid');
      }
      const proposalClaimId = requiredText(raw?.id, 'autonomous_theorem_claim_id_invalid', 500).trim();
      const proposalClaimText = requiredText(raw?.text, 'autonomous_theorem_claim_text_invalid');
      claims.push(Object.freeze({
        claimAuthorityType: 'machine-policy-authorized',
        claimAuthorityBindingHash: claimedBindingHash || null,
        claimAuthorityBundleHash: claimedBundleHash || null,
        proposalClaimId,
        proposalClaimText,
        scientificClaimKey: requiredText(raw?.scientificClaimKey, 'autonomous_theorem_scientific_claim_key_invalid', 160).trim(),
        ...Object.fromEntries(SCIENTIFIC_SCOPE_FIELDS.map((field) => [
          field,
          requiredTextList(raw?.[field], `autonomous_theorem_${field}_invalid`),
        ])),
        proposalClaimTextHash: hashBytes(Buffer.from(proposalClaimText, 'utf8')),
        proposalClaimRecordHash: hashRecord('AutonomousResearchClaimRecord', raw),
        proposalSeedContractBundleHash: null,
        approvedProposalSeedBindingHash: null,
        ...(dynamicFormal ? {
          dynamicFormalClaimSeedHash: raw.dynamicFormalClaimSeedHash,
          leanDeclarationName: raw.leanDeclarationName,
          leanTypeSource: raw.leanTypeSource,
          leanTypeSourceHash: raw.leanTypeSourceHash,
          leanNormalizedTypeHash: raw.leanNormalizedTypeHash,
          allowedImports: Object.freeze([...raw.allowedImports]),
          formalClaimCapabilityScopeManifestHash:
            raw.formalClaimCapabilityScopeManifestHash,
          formalClaimGeneratorReceiptHash: raw.formalClaimGeneratorReceiptHash,
        } : {}),
      }));
    } catch (error) {
      blockers.push(`${error?.message || 'autonomous_theorem_claim_invalid'}:${index + 1}`);
    }
  }
  const ids = claims.map((claim) => claim.proposalClaimId);
  if (new Set(ids).size !== ids.length) blockers.push('autonomous_theorem_claim_ids_duplicate');
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'autonomous_research_seed_lineage_authority_blocked'
      : 'autonomous_research_seed_lineage_authority_verified',
    claimAuthorityType: 'machine-policy-authorized',
    claimAuthorityBindingHash: claimedBindingHash || null,
    claimAuthorityBundleHash: claimedBundleHash || null,
    approvedProposalSeedBindingHash: null,
    proposalSeedContractBundleHash: null,
    claims: Object.freeze(claims),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

export function verifyScientificClaimLineageAuthority({
  scientificClaimAuthority,
  seedContractBundle,
  paperId,
} = {}) {
  if (scientificClaimAuthority?.kind === 'AutonomousResearchSeedBinding') {
    return verifyAutonomousResearchSeedLineageAuthority({
      scientificClaimAuthority,
      autonomousResearchSeedContractBundle: seedContractBundle,
      paperId,
    });
  }
  return verifyApprovedProposalSeedLineageAuthority({
    approvedProposalSeed: scientificClaimAuthority,
    proposalSeedContractBundle: seedContractBundle,
    paperId,
  });
}

export function proposalClaimSourceFromAuthority(authorityClaim) {
  const dynamicFormal = Boolean(authorityClaim?.dynamicFormalClaimSeedHash);
  const source = {
    claimAuthorityType: requiredText(authorityClaim?.claimAuthorityType, 'proposal_claim_source_authority_type_invalid', 100).trim(),
    claimAuthorityBindingHash: String(authorityClaim?.claimAuthorityBindingHash || '').toLowerCase(),
    claimAuthorityBundleHash: String(authorityClaim?.claimAuthorityBundleHash || '').toLowerCase(),
    proposalClaimId: requiredText(authorityClaim?.proposalClaimId, 'proposal_claim_source_id_invalid', 500).trim(),
    proposalClaimText: requiredText(authorityClaim?.proposalClaimText, 'proposal_claim_source_text_invalid'),
    scientificClaimKey: requiredText(authorityClaim?.scientificClaimKey, 'proposal_claim_source_scientific_claim_key_invalid', 128).trim(),
    ...Object.fromEntries(SCIENTIFIC_SCOPE_FIELDS.map((field) => [
      field,
      requiredTextList(authorityClaim?.[field], `proposal_claim_source_${field}_invalid`),
    ])),
    proposalClaimTextHash: String(authorityClaim?.proposalClaimTextHash || '').toLowerCase(),
    proposalClaimRecordHash: String(authorityClaim?.proposalClaimRecordHash || '').toLowerCase(),
    proposalSeedContractBundleHash: authorityClaim?.proposalSeedContractBundleHash
      ? String(authorityClaim.proposalSeedContractBundleHash).toLowerCase() : null,
    approvedProposalSeedBindingHash: authorityClaim?.approvedProposalSeedBindingHash
      ? String(authorityClaim.approvedProposalSeedBindingHash).toLowerCase() : null,
    ...(dynamicFormal ? {
      dynamicFormalClaimSeedHash: String(authorityClaim.dynamicFormalClaimSeedHash || '').toLowerCase(),
      leanDeclarationName: requiredText(
        authorityClaim.leanDeclarationName,
        'proposal_claim_source_lean_declaration_name_invalid',
        160,
      ).trim(),
      leanTypeSource: requiredText(
        authorityClaim.leanTypeSource,
        'proposal_claim_source_lean_type_source_invalid',
        16_000,
      ).trim(),
      leanTypeSourceHash: String(authorityClaim.leanTypeSourceHash || '').toLowerCase(),
      leanNormalizedTypeHash: String(authorityClaim.leanNormalizedTypeHash || '').toLowerCase(),
      allowedImports: requiredTextList(
        authorityClaim.allowedImports,
        'proposal_claim_source_allowed_imports_invalid',
      ),
      formalClaimCapabilityScopeManifestHash: String(
        authorityClaim.formalClaimCapabilityScopeManifestHash || '',
      ).toLowerCase(),
      formalClaimGeneratorReceiptHash: String(
        authorityClaim.formalClaimGeneratorReceiptHash || '',
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
      !/^[A-Za-z_][A-Za-z0-9_'.]*$/.test(source.leanDeclarationName)
      || !dynamicFormalLeanTypeSourceValid(source.leanTypeSource)
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
    throw new Error('proposal_claim_source_hash_invalid');
  }
  return Object.freeze(source);
}

export function createProposalClaimToTheoremBinding({
  paperId,
  campaignId,
  theoremSpecification,
  reviews,
  reviewAuthority,
} = {}) {
  if (theoremSpecification?.proposalClaimLineageRequired !== true) {
    throw new Error('proposal_claim_to_theorem_lineage_not_required');
  }
  const specificationClaims = Array.isArray(theoremSpecification?.claims) ? theoremSpecification.claims : [];
  const reviewEntries = Array.isArray(reviews) ? reviews : [];
  if (!specificationClaims.length || reviewEntries.length !== specificationClaims.length) {
    throw new Error('proposal_claim_to_theorem_review_count_mismatch');
  }
  const reviewByClaim = new Map();
  for (const review of reviewEntries) {
    if (!review?.claimId || reviewByClaim.has(review.claimId)) {
      throw new Error('proposal_claim_to_theorem_review_claim_duplicate');
    }
    reviewByClaim.set(review.claimId, review);
  }
  const proposalIds = new Set();
  const entries = specificationClaims.map((claim) => {
    const source = proposalClaimSourceFromAuthority(claim?.proposalClaimSource);
    if (source.claimAuthorityType !== theoremSpecification.claimAuthorityType
      || source.claimAuthorityBindingHash !== theoremSpecification.claimAuthorityBindingHash
      || source.claimAuthorityBundleHash !== theoremSpecification.claimAuthorityBundleHash) {
      throw new Error('proposal_claim_to_theorem_source_authority_mismatch');
    }
    if (proposalIds.has(source.proposalClaimId)) {
      throw new Error('proposal_claim_to_theorem_proposal_claim_duplicate');
    }
    proposalIds.add(source.proposalClaimId);
    const review = reviewByClaim.get(claim.claimId);
    if (!review
      || review.proposalClaimId !== source.proposalClaimId
      || review.proposalClaimRecordHash !== source.proposalClaimRecordHash
      || review.proposalClaimTextHash !== source.proposalClaimTextHash
      || review.proposalToTheoremSemanticVerified !== true
      || !RELATIONS.has(review.proposalToTheoremVerdict)) {
      throw new Error(`proposal_claim_to_theorem_semantic_review_invalid:${claim?.claimId || 'missing'}`);
    }
    if (review.approvedNarrowingRationale !== null) {
      throw new Error(`proposal_claim_to_theorem_equivalent_rationale_must_be_null:${claim.claimId}`);
    }
    return Object.freeze({
      proposalClaimId: source.proposalClaimId,
      proposalClaimText: source.proposalClaimText,
      scientificClaimKey: source.scientificClaimKey,
      assumptions: source.assumptions,
      quantifiers: source.quantifiers,
      negativeBoundaries: source.negativeBoundaries,
      proofObligations: source.proofObligations,
      proposalClaimTextHash: source.proposalClaimTextHash,
      proposalClaimRecordHash: source.proposalClaimRecordHash,
      theoremClaimId: claim.claimId,
      theoremStatement: claim.statement,
      theoremSpecificationClaimHash: claim.theoremSpecificationClaimHash,
      proposalToTheoremVerdict: review.proposalToTheoremVerdict,
      approvedNarrowingRationale: null,
      proposalToTheoremSemanticVerified: true,
    });
  });
  if (reviewByClaim.size !== entries.length) throw new Error('proposal_claim_to_theorem_review_claim_unregistered');
  for (const field of ['reviewAgentReceiptHash', 'reviewerPrincipalId']) {
    if (!SHA256.test(String(reviewAuthority?.[field] || ''))) {
      throw new Error(`proposal_claim_to_theorem_${field}_invalid`);
    }
  }
  const payload = {
    version: 1,
    kind: 'ProposalClaimToTheoremBinding',
    status: 'proposal_claim_to_theorem_binding_verified',
    paperId: requiredText(paperId, 'proposal_claim_to_theorem_paper_id_required', 500).trim(),
    campaignId: requiredText(campaignId, 'proposal_claim_to_theorem_campaign_id_required', 500).trim(),
    approvedProposalSeedBindingHash: theoremSpecification.approvedProposalSeedBindingHash,
    proposalSeedContractBundleHash: theoremSpecification.proposalSeedContractBundleHash,
    claimAuthorityType: theoremSpecification.claimAuthorityType,
    claimAuthorityBindingHash: theoremSpecification.claimAuthorityBindingHash,
    claimAuthorityBundleHash: theoremSpecification.claimAuthorityBundleHash,
    theoremSpecificationHash: theoremSpecification.theoremSpecificationHash,
    reviewAgentReceiptHash: reviewAuthority.reviewAgentReceiptHash,
    reviewerPrincipalId: reviewAuthority.reviewerPrincipalId,
    relationPolicy: 'exact-semantic-equivalence-only-v1',
    proposalClaimCount: entries.length,
    theoremClaimCount: entries.length,
    entries: Object.freeze(entries),
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    proposalClaimToTheoremBindingHash: hashRecord('ProposalClaimToTheoremBinding', payload),
  });
}

export function verifyProposalClaimToTheoremBinding(binding, expected = {}) {
  const blockers = [];
  const {
    theoremSpecification: expectedTheoremSpecification = null,
    reviews: expectedReviews = null,
    ...expectedScalars
  } = expected || {};
  const { proposalClaimToTheoremBindingHash: claimedHash, ...payload } = binding || {};
  if (!binding || binding.version !== 1 || binding.kind !== 'ProposalClaimToTheoremBinding'
    || binding.status !== 'proposal_claim_to_theorem_binding_verified'
    || !claimedHash || hashRecord('ProposalClaimToTheoremBinding', payload) !== claimedHash) {
    blockers.push('proposal_claim_to_theorem_binding_hash_invalid');
  }
  const entries = Array.isArray(binding?.entries) ? binding.entries : [];
  const proposalIds = entries.map((entry) => entry?.proposalClaimId);
  const theoremIds = entries.map((entry) => entry?.theoremClaimId);
  if (!entries.length || Number(binding?.proposalClaimCount) !== entries.length
    || Number(binding?.theoremClaimCount) !== entries.length
    || new Set(proposalIds).size !== entries.length || new Set(theoremIds).size !== entries.length
    || entries.some((entry) => entry?.proposalToTheoremSemanticVerified !== true
      || !RELATIONS.has(entry?.proposalToTheoremVerdict)
      || entry?.proposalClaimTextHash !== hashBytes(Buffer.from(String(entry?.proposalClaimText || ''), 'utf8'))
      || !String(entry?.scientificClaimKey || '').trim()
      || SCIENTIFIC_SCOPE_FIELDS.some((field) => !Array.isArray(entry?.[field]) || !entry[field].length)
      || !SHA256.test(String(entry?.proposalClaimRecordHash || ''))
      || !SHA256.test(String(entry?.theoremSpecificationClaimHash || ''))
      || entry?.approvedNarrowingRationale !== null)) {
    blockers.push('proposal_claim_to_theorem_binding_entries_invalid');
  }
  for (const [field, expectedValue] of Object.entries(expectedScalars)) {
    if (expectedValue !== undefined && expectedValue !== null && binding?.[field] !== expectedValue) {
      blockers.push(`proposal_claim_to_theorem_binding_${field}_mismatch`);
    }
  }
  if (expectedTheoremSpecification) {
    const specificationClaims = Array.isArray(expectedTheoremSpecification.claims)
      ? expectedTheoremSpecification.claims : [];
    const entryByTheoremId = new Map(entries.map((entry) => [entry?.theoremClaimId, entry]));
    if (expectedTheoremSpecification.proposalClaimLineageRequired !== true
      || binding?.theoremSpecificationHash !== expectedTheoremSpecification.theoremSpecificationHash
      || binding?.approvedProposalSeedBindingHash
        !== expectedTheoremSpecification.approvedProposalSeedBindingHash
      || binding?.proposalSeedContractBundleHash
        !== expectedTheoremSpecification.proposalSeedContractBundleHash
      || binding?.claimAuthorityType !== expectedTheoremSpecification.claimAuthorityType
      || binding?.claimAuthorityBindingHash !== expectedTheoremSpecification.claimAuthorityBindingHash
      || binding?.claimAuthorityBundleHash !== expectedTheoremSpecification.claimAuthorityBundleHash
      || specificationClaims.length !== entries.length) {
      blockers.push('proposal_claim_to_theorem_binding_specification_summary_mismatch');
    }
    for (const claim of specificationClaims) {
      let source = null;
      try { source = proposalClaimSourceFromAuthority(claim?.proposalClaimSource); }
      catch { blockers.push(`proposal_claim_to_theorem_binding_specification_source_invalid:${claim?.claimId || 'missing'}`); }
      const entry = entryByTheoremId.get(claim?.claimId);
      if (!entry || !source
        || entry.proposalClaimId !== source.proposalClaimId
        || entry.proposalClaimText !== source.proposalClaimText
        || entry.scientificClaimKey !== source.scientificClaimKey
        || SCIENTIFIC_SCOPE_FIELDS.some((field) => JSON.stringify(entry[field]) !== JSON.stringify(source[field]))
        || entry.proposalClaimTextHash !== source.proposalClaimTextHash
        || entry.proposalClaimRecordHash !== source.proposalClaimRecordHash
        || entry.theoremStatement !== claim.statement
        || entry.theoremSpecificationClaimHash !== claim.theoremSpecificationClaimHash) {
        blockers.push(`proposal_claim_to_theorem_binding_specification_entry_mismatch:${claim?.claimId || 'missing'}`);
      }
    }
  }
  if (expectedReviews !== null) {
    const reviews = Array.isArray(expectedReviews) ? expectedReviews : [];
    const reviewByClaimId = new Map();
    for (const review of reviews) {
      if (!review?.claimId || reviewByClaimId.has(review.claimId)) {
        blockers.push('proposal_claim_to_theorem_binding_expected_reviews_duplicate');
      } else reviewByClaimId.set(review.claimId, review);
    }
    if (reviews.length !== entries.length) blockers.push('proposal_claim_to_theorem_binding_expected_reviews_count_mismatch');
    for (const entry of entries) {
      const review = reviewByClaimId.get(entry?.theoremClaimId);
      if (!review
        || review.proposalClaimId !== entry.proposalClaimId
        || review.proposalClaimTextHash !== entry.proposalClaimTextHash
        || review.proposalClaimRecordHash !== entry.proposalClaimRecordHash
        || review.proposalToTheoremSemanticVerified !== true
        || review.proposalToTheoremVerdict !== entry.proposalToTheoremVerdict
        || (review.approvedNarrowingRationale ?? null) !== entry.approvedNarrowingRationale) {
        blockers.push(`proposal_claim_to_theorem_binding_expected_review_mismatch:${entry?.theoremClaimId || 'missing'}`);
      }
    }
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'proposal_claim_to_theorem_binding_verification_blocked'
      : 'proposal_claim_to_theorem_binding_verification_verified',
    proposalClaimToTheoremBindingHash: claimedHash || null,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
