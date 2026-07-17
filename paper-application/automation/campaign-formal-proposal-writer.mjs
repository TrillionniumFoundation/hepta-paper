import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { verifyScientificClaimLineageAuthority } from '../../paper-domain/research/proposal-claim-to-theorem-binding.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/i;

const DEFERRED_READINESS_BLOCKERS = new Set([
  'theorem_proof_status_missing',
  'theorem_evidence_manifest_missing',
  'theorem_appendix_or_supplement_missing',
]);

function formalQualityRequested(campaign) {
  return [
    campaign?.spec?.paperQualityProfile,
    ...(campaign?.spec?.paperQualityProfiles || []),
  ].includes('formal_theorem_or_proof');
}

function approvedProposalSeedRelativePath(binding) {
  return String(binding?.contractPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .at(-1) || null;
}

export function verifyApprovedFormalProposalWriterSeed({
  primitives,
  campaign,
  node,
  workspace,
} = {}) {
  const approvedBinding = campaign?.spec?.approvedProposalSeed || null;
  const machineBinding = campaign?.spec?.scientificClaimAuthority || null;
  if (approvedBinding && machineBinding) {
    const error = new Error('formal_scientific_claim_authority_ambiguous');
    error.retryable = false;
    throw error;
  }
  const binding = machineBinding || approvedBinding;
  if (node?.kind !== 'writer'
    || !formalQualityRequested(campaign)
    || !binding) return null;
  if (machineBinding) {
    const relative = approvedProposalSeedRelativePath(binding);
    let seedContractBundle = null;
    try {
      seedContractBundle = relative
        ? JSON.parse(primitives.workspace.readTextIfPresent({ workspace, relative }) || 'null')
        : null;
    } catch {
      const error = new Error('autonomous_formal_seed_invalid:autonomous_theorem_seed_json_invalid');
      error.retryable = false;
      throw error;
    }
    const authority = verifyScientificClaimLineageAuthority({
      scientificClaimAuthority: binding,
      seedContractBundle,
      paperId: campaign?.paperId,
    });
    if (!relative || !authority.valid || !authority.claims.length) {
      const blockers = [
        ...(!relative ? ['autonomous_theorem_seed_path_required'] : []),
        ...authority.blockers,
        ...(!authority.claims.length ? ['autonomous_theorem_formal_claims_missing'] : []),
      ];
      const error = new Error(`autonomous_formal_seed_invalid:${[...new Set(blockers)].join(',')}`);
      error.retryable = false;
      error.receipt = Object.freeze({ blockers, relative, externalActionPerformed: false });
      throw error;
    }
    const payload = {
      version: 1,
      kind: 'ScientificClaimAuthorityVerificationReceipt',
      status: 'scientific_claim_authority_verified',
      campaignId: campaign.campaignId,
      paperId: campaign.paperId,
      relativePath: relative,
      claimAuthorityType: authority.claimAuthorityType,
      claimAuthorityBindingHash: authority.claimAuthorityBindingHash,
      claimAuthorityBundleHash: authority.claimAuthorityBundleHash,
      formalClaimCount: authority.claims.length,
      externalActionPerformed: false,
    };
    return Object.freeze({
      ...payload,
      scientificClaimAuthorityVerificationReceiptHash:
        hashRecord('ScientificClaimAuthorityVerificationReceipt', payload),
    });
  }
  if (binding?.status !== 'approved_proposal_seed_bound') return null;
  const relative = approvedProposalSeedRelativePath(binding);
  const bindingPayload = {
    version: binding?.version,
    kind: binding?.kind,
    status: binding?.status,
    contractPath: binding?.contractPath,
    proposalEnvelopeHash: binding?.proposalEnvelopeHash,
    productionPlanEnvelopeHash: binding?.productionPlanEnvelopeHash,
    reviewGateHash: binding?.reviewGateHash,
    proposalSeedContractBundleHash: binding?.proposalSeedContractBundleHash,
  };
  const blockers = [];
  if (!binding?.approvedProposalSeedBindingHash
    || hashRecord('ApprovedProposalSeedBinding', bindingPayload) !== binding.approvedProposalSeedBindingHash) {
    blockers.push('approved_proposal_seed_binding_hash_invalid');
  }
  let bundle = null;
  try {
    bundle = relative
      ? JSON.parse(primitives.workspace.readTextIfPresent({ workspace, relative }) || 'null')
      : null;
  } catch {
    blockers.push('approved_proposal_seed_contract_invalid_json');
  }
  const {
    paperProposalSeedContractBundleHash: claimedBundleHash,
    ...bundlePayload
  } = bundle || {};
  if (!relative) blockers.push('approved_proposal_seed_contract_path_missing');
  if (bundle?.kind !== 'PaperProposalSeedContractBundle'
    || bundle?.status !== 'proposal_seed_contracts_ready') {
    blockers.push('approved_proposal_seed_contract_not_ready');
  }
  if (bundle?.paperId !== campaign?.paperId) blockers.push('approved_proposal_seed_paper_mismatch');
  if (bundle?.proposalEnvelopeHash !== binding?.proposalEnvelopeHash
    || bundle?.productionPlanEnvelopeHash !== binding?.productionPlanEnvelopeHash
    || bundle?.reviewGateHash !== binding?.reviewGateHash) {
    blockers.push('approved_proposal_seed_authority_binding_mismatch');
  }
  if (!claimedBundleHash
    || claimedBundleHash !== binding?.proposalSeedContractBundleHash
    || hashPaperRecord('PaperProposalSeedContractBundle', bundlePayload) !== claimedBundleHash) {
    blockers.push('approved_proposal_seed_contract_hash_invalid');
  }
  if (!Array.isArray(bundle?.claims) || bundle.claims.length === 0) {
    blockers.push('approved_proposal_seed_claims_missing');
  }
  if (!SHA256.test(String(bundle?.scientificClaimInputHash || ''))
    || (bundle?.claims || []).some((claim) => claim?.scientificClaimInputHash !== bundle.scientificClaimInputHash
      || !String(claim?.scientificClaimKey || '').trim()
      || !Array.isArray(claim?.assumptions) || claim.assumptions.length === 0
      || !Array.isArray(claim?.quantifiers) || claim.quantifiers.length === 0
      || !Array.isArray(claim?.negativeBoundaries) || claim.negativeBoundaries.length === 0
      || !Array.isArray(claim?.proofObligations) || claim.proofObligations.length === 0)) {
    blockers.push('approved_proposal_scientific_claim_authority_missing');
  }
  if (!Array.isArray(bundle?.proof_obligations) || bundle.proof_obligations.length === 0) {
    blockers.push('approved_proposal_seed_proof_obligations_missing');
  }
  if (Array.isArray(bundle?.blockers) && bundle.blockers.length > 0) {
    blockers.push('approved_proposal_seed_contract_blocked');
  }
  if (blockers.length) {
    const error = new Error(`approved_formal_proposal_seed_invalid:${blockers.join(',')}`);
    error.retryable = false;
    error.receipt = Object.freeze({ blockers, relative, externalActionPerformed: false });
    throw error;
  }
  const payload = {
    version: 1,
    kind: 'ApprovedProposalSeedVerificationReceipt',
    status: 'approved_proposal_seed_verified',
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    relativePath: relative,
    approvedProposalSeedBindingHash: binding.approvedProposalSeedBindingHash,
    proposalSeedContractBundleHash: claimedBundleHash,
    scientificClaimInputHash: bundle.scientificClaimInputHash,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    approvedProposalSeedVerificationReceiptHash: hashRecord('ApprovedProposalSeedVerificationReceipt', payload),
  });
}

function limitationsBodyPresent(primitives, workspace, manuscript) {
  const source = primitives.workspace.readTextIfPresent({ workspace, relative: manuscript }) || '';
  const match = source.match(/\\section\*?\{limitations?\}([\s\S]*?)(?=\\section\*?\{|\\appendix|\\end\{document\}|$)/i);
  if (!match) return false;
  return match[1]
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g, ' ')
    .trim().length > 0;
}

export function verifyFormalProposalWriterSurface({ primitives, campaign, workspace, manuscript } = {}) {
  const readiness = primitives.quality.theoremReadiness({
    workspacePath: workspace,
    manuscriptPath: manuscript,
    paperId: campaign.paperId,
    profile: 'formal_theorem_or_proof',
  });
  const blockers = (readiness.blockers || [])
    .filter((blocker) => !DEFERRED_READINESS_BLOCKERS.has(blocker));
  if (!readiness.manuscriptQualitySurfaces?.limitationsPresent) {
    blockers.push('formal_proposal_writer_limitations_missing');
  } else if (!limitationsBodyPresent(primitives, workspace, manuscript)) {
    blockers.push('formal_proposal_writer_limitations_empty');
  }
  if (blockers.length) {
    const error = new Error(`formal_proposal_writer_surface_blocked:${blockers.join(',')}`);
    error.retryable = true;
    error.receipt = Object.freeze({
      version: 1,
      kind: 'FormalProposalWriterSurfaceRejection',
      status: 'formal_proposal_writer_surface_blocked',
      blockers: Object.freeze([...blockers]),
      theoremReadiness: readiness,
      externalActionPerformed: false,
    });
    throw error;
  }
  return readiness;
}
