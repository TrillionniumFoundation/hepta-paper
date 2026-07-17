import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { PAPER_CORE_VERSION, hashPaperRecord, normalizeRefs } from './primitives.mjs';
import { PAPER_ACTIONS } from './product-profile.mjs';
import { PAPER_QUALITY_PROFILES } from '../quality/paper-quality-policy.mjs';
import { verifyPaperScientificClaimInput } from './scientific-claim-input.mjs';

function normalizeList(values = [], limit = 32) {
  if (typeof values === 'string') return uniqueStrings(values.split(/\n|;/), limit);
  return uniqueStrings(values || [], limit);
}

function normalizePaperQualityProfiles(values = []) {
  return normalizeList(values, 8).filter((profile) => Object.hasOwn(PAPER_QUALITY_PROFILES, profile));
}

function exactStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

function exactListsMatch(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function paperProposalContributionClaimHashes({ proposalEnvelope } = {}) {
  const paperId = normalizeText(proposalEnvelope?.paperId);
  return (proposalEnvelope?.proposal?.contributionClaims || []).map((claim, index) => hashPaperRecord(
    'PaperProposalContributionClaim',
    {
      paperId,
      claimIndex: index,
      claim: normalizeText(claim),
    },
  ));
}

export function paperProposalRiskHashes({ proposalEnvelope } = {}) {
  const paperId = normalizeText(proposalEnvelope?.paperId);
  return [
    ['novelty', proposalEnvelope?.proposal?.noveltyRisk],
    ['feasibility', proposalEnvelope?.proposal?.feasibilityRisk],
  ].map(([riskType, risk]) => hashPaperRecord('PaperProposalRisk', {
    paperId,
    riskType,
    risk: normalizeText(risk),
  }));
}

export function buildPaperProposalApprovalBinding({
  ideaBrief,
  proposalEnvelope,
  generationReceipt,
} = {}) {
  if (!ideaBrief?.kind || !proposalEnvelope?.kind || !generationReceipt?.kind) {
    throw new Error('PaperProposalApprovalBinding requires ideaBrief, proposalEnvelope, and generationReceipt');
  }
  return Object.freeze({
    paperId: proposalEnvelope.paperId || null,
    proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
    generationReceiptHash: generationReceipt.paperProposalGenerationReceiptHash,
    targetVenue: normalizeText(ideaBrief.targetVenue) || null,
    contributionClaimHashes: Object.freeze(paperProposalContributionClaimHashes({ proposalEnvelope })),
    qualityProfiles: Object.freeze([...(proposalEnvelope.proposal?.recommendedPaperQualityProfiles || [])]),
    riskHashes: Object.freeze(paperProposalRiskHashes({ proposalEnvelope })),
  });
}

export function createPaperProposalApprovalDocument({
  ideaBrief,
  proposalEnvelope,
  generationReceipt,
  operatorIdentity,
  riskAcceptanceRationale,
  signedAt,
  validFrom = null,
  expiresAt,
} = {}) {
  const binding = buildPaperProposalApprovalBinding({ ideaBrief, proposalEnvelope, generationReceipt });
  return {
    version: 1,
    kind: 'PaperProposalApprovalDocument',
    decision: 'approve',
    paperId: binding.paperId,
    proposalEnvelopeHash: binding.proposalEnvelopeHash,
    generationReceiptHash: binding.generationReceiptHash,
    targetVenue: binding.targetVenue,
    contributionClaimHashes: [...binding.contributionClaimHashes],
    qualityProfiles: [...binding.qualityProfiles],
    riskAcceptance: {
      status: 'accepted',
      acceptedRiskHashes: [...binding.riskHashes],
      rationale: normalizeText(riskAcceptanceRationale),
    },
    operatorIdentity: {
      ...(operatorIdentity || {}),
      subjectId: normalizeText(operatorIdentity?.subjectId) || null,
      role: 'proposal_approver',
    },
    signedAt: signedAt || null,
    validFrom: validFrom || signedAt || null,
    expiresAt: expiresAt || null,
  };
}

export function validatePaperProposalApprovalDocument({
  ideaBrief,
  proposalEnvelope,
  generationReceipt,
  approvalDocument,
} = {}) {
  const binding = buildPaperProposalApprovalBinding({ ideaBrief, proposalEnvelope, generationReceipt });
  const blockers = [];
  if (approvalDocument?.version !== 1 || approvalDocument?.kind !== 'PaperProposalApprovalDocument') {
    blockers.push('proposal_approval_document_missing_or_invalid');
  }
  if (approvalDocument?.decision !== 'approve') blockers.push('proposal_approval_decision_not_approve');
  if (approvalDocument?.paperId !== binding.paperId) blockers.push('proposal_approval_paper_id_mismatch');
  if (approvalDocument?.proposalEnvelopeHash !== binding.proposalEnvelopeHash) {
    blockers.push('proposal_approval_envelope_hash_mismatch');
  }
  if (approvalDocument?.generationReceiptHash !== binding.generationReceiptHash) {
    blockers.push('proposal_approval_generation_receipt_hash_mismatch');
  }
  if (approvalDocument?.targetVenue !== binding.targetVenue) blockers.push('proposal_approval_target_venue_mismatch');
  const claimHashes = exactStringList(approvalDocument?.contributionClaimHashes);
  if (!claimHashes || !exactListsMatch(claimHashes, binding.contributionClaimHashes)) {
    blockers.push('proposal_approval_contribution_claim_hashes_mismatch');
  }
  const qualityProfiles = exactStringList(approvalDocument?.qualityProfiles);
  if (!qualityProfiles || !exactListsMatch(qualityProfiles, binding.qualityProfiles)) {
    blockers.push('proposal_approval_quality_profiles_mismatch');
  }
  const acceptedRiskHashes = exactStringList(approvalDocument?.riskAcceptance?.acceptedRiskHashes);
  if (approvalDocument?.riskAcceptance?.status !== 'accepted'
    || !acceptedRiskHashes
    || !exactListsMatch(acceptedRiskHashes, binding.riskHashes)) {
    blockers.push('proposal_approval_risk_acceptance_mismatch');
  }
  if (!normalizeText(approvalDocument?.riskAcceptance?.rationale)) {
    blockers.push('proposal_approval_risk_acceptance_rationale_missing');
  }
  if (!normalizeText(approvalDocument?.operatorIdentity?.subjectId)
    || approvalDocument?.operatorIdentity?.role !== 'proposal_approver') {
    blockers.push('proposal_approval_operator_identity_invalid');
  }
  return {
    status: blockers.length ? 'proposal_approval_binding_blocked' : 'proposal_approval_binding_verified',
    binding,
    blockers: uniqueStrings(blockers, 32),
  };
}

export function createPaperIdeaBrief({
  idea,
  paperId = null,
  title = null,
  discipline = null,
  targetVenue = null,
  paperType = null,
  materials = [],
  constraints = [],
  riskPreference = null,
  createdAt = null,
} = {}) {
  const normalizedIdea = normalizeText(idea);
  if (!normalizedIdea) throw new Error('PaperIdeaBrief requires idea');
  const brief = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperIdeaBrief',
    paperId: normalizeText(paperId) || null,
    title: normalizeText(title) || null,
    idea: normalizedIdea,
    discipline: normalizeText(discipline) || null,
    targetVenue: normalizeText(targetVenue) || null,
    paperType: normalizeText(paperType) || null,
    materials: normalizeList(materials, 32),
    constraints: normalizeList(constraints, 32),
    riskPreference: normalizeText(riskPreference) || 'balanced',
    status: 'idea_brief_recorded',
    safety: {
      sourceMutation: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...brief, paperIdeaBriefHash: hashPaperRecord('PaperIdeaBrief', brief) };
}

export function createPaperProposalGenerationManifest({
  ideaBrief,
  disciplineProfile = null,
  venueProfile = null,
  promptTemplate = null,
  mode = 'local-deterministic-draft',
  createdAt = null,
} = {}) {
  if (!ideaBrief?.kind) throw new Error('PaperProposalGenerationManifest requires ideaBrief');
  const blockers = [];
  if (!disciplineProfile?.id) blockers.push('discipline_profile_missing');
  if (!venueProfile?.id) blockers.push('venue_profile_missing');
  const manifest = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperProposalGenerationManifest',
    paperId: ideaBrief.paperId || null,
    action: PAPER_ACTIONS.PROPOSAL_GENERATE,
    mode: normalizeText(mode) || 'local-deterministic-draft',
    status: blockers.length ? 'blocked_manifest' : 'ready_for_local_proposal_draft',
    ideaBriefHash: ideaBrief.paperIdeaBriefHash,
    disciplineProfile,
    venueProfile,
    promptTemplate: promptTemplate || {
      id: 'paper-proposal-local-draft-v1',
      source: 'paper-adapters/proposal',
      modelCallRequired: false,
    },
    blockers: uniqueStrings(blockers, 32),
    safety: {
      promptOnly: true,
      localDeterministicDraft: true,
      modelCallPerformed: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return {
    ...manifest,
    paperProposalGenerationManifestHash: hashPaperRecord('PaperProposalGenerationManifest', manifest),
  };
}

export function createPaperProposalEnvelope({
  ideaBrief,
  generationManifest,
  proposal,
  createdAt = null,
} = {}) {
  if (!ideaBrief?.kind || !generationManifest?.kind) {
    throw new Error('PaperProposalEnvelope requires ideaBrief and generationManifest');
  }
  const blockers = [...(generationManifest.blockers || [])];
  const scientificClaimInputVerification = verifyPaperScientificClaimInput(proposal?.scientificClaimInput);
  const scientificClaimInput = scientificClaimInputVerification.valid
    ? proposal.scientificClaimInput
    : null;
  const normalizedProposal = {
    tentativeTitle: normalizeText(proposal?.tentativeTitle || ideaBrief.title || ideaBrief.idea.slice(0, 96)),
    abstract: normalizeText(proposal?.abstract || ''),
    centralThesis: normalizeText(proposal?.centralThesis || ideaBrief.idea),
    contributionClaims: normalizeList(proposal?.contributionClaims || [], 12),
    scientificClaimInput,
    expectedStructure: normalizeList(proposal?.expectedStructure || [], 16),
    proofObligations: normalizeList(proposal?.proofObligations || [], 16),
    evidencePlan: normalizeList(proposal?.evidencePlan || [], 16),
    reproducibilityPlan: normalizeList(proposal?.reproducibilityPlan || [], 16),
    venueFit: normalizeText(proposal?.venueFit || ''),
    noveltyRisk: normalizeText(proposal?.noveltyRisk || 'needs_literature_scan'),
    feasibilityRisk: normalizeText(proposal?.feasibilityRisk || 'needs_manual_review'),
    requiredArtifacts: normalizeList(proposal?.requiredArtifacts || [], 16),
    recommendedPaperQualityProfiles: normalizePaperQualityProfiles(proposal?.recommendedPaperQualityProfiles || []),
  };
  if (!normalizedProposal.abstract) blockers.push('proposal_abstract_missing');
  if (!normalizedProposal.contributionClaims.length) blockers.push('proposal_claims_missing');
  if (!normalizedProposal.recommendedPaperQualityProfiles.length) blockers.push('proposal_quality_profile_recommendation_missing');
  if (proposal?.scientificClaimInput && !scientificClaimInput) {
    blockers.push('proposal_scientific_claim_input_invalid');
  }
  const formalProposal = normalizedProposal.recommendedPaperQualityProfiles.includes('formal_theorem_or_proof');
  if (formalProposal && !scientificClaimInput) {
    blockers.push('formal_scientific_claim_input_required');
  }
  if (scientificClaimInput) {
    const scientificStatements = scientificClaimInput.claims.map((claim) => claim.statement);
    const scientificProofObligations = uniqueStrings(
      scientificClaimInput.claims.flatMap((claim) => claim.proofObligations),
      16,
    );
    if (!exactListsMatch(normalizedProposal.contributionClaims, scientificStatements)
      || !exactListsMatch(normalizedProposal.proofObligations, scientificProofObligations)) {
      blockers.push('proposal_scientific_claim_input_projection_mismatch');
    }
  }
  const envelope = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperProposalEnvelope',
    paperId: ideaBrief.paperId || null,
    title: normalizedProposal.tentativeTitle,
    status: blockers.length ? 'blocked_proposal_draft' : 'proposal_draft_ready_for_review',
    ideaBriefHash: ideaBrief.paperIdeaBriefHash,
    generationManifestHash: generationManifest.paperProposalGenerationManifestHash,
    disciplineProfileId: generationManifest.disciplineProfile?.id || null,
    venueProfileId: generationManifest.venueProfile?.id || null,
    proposal: normalizedProposal,
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings([
      ...(proposal?.warnings || []),
      ...(scientificClaimInput
        ? ['scientific_claim_novelty_and_correctness_not_automatically_verified']
        : []),
    ], 32),
    safety: {
      draftOnly: true,
      operatorScientificClaimInputBound: Boolean(scientificClaimInput),
      noveltyAutomaticallyVerified: false,
      scientificCorrectnessAutomaticallyVerified: false,
      sourceMutation: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...envelope, paperProposalEnvelopeHash: hashPaperRecord('PaperProposalEnvelope', envelope) };
}

export function buildPaperProposalGenerationReceipt({
  generationManifest,
  proposalEnvelope,
  createdAt = null,
} = {}) {
  if (!generationManifest?.kind || !proposalEnvelope?.kind) {
    throw new Error('PaperProposalGenerationReceipt requires manifest and proposalEnvelope');
  }
  const blockers = [
    ...(generationManifest.blockers || []),
    ...(proposalEnvelope.blockers || []),
  ];
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperProposalGenerationReceipt',
    paperId: proposalEnvelope.paperId || null,
    status: blockers.length ? 'blocked_proposal_generation' : 'proposal_generation_recorded',
    result: blockers.length ? 'blocked' : 'local_draft_created',
    generationManifestHash: generationManifest.paperProposalGenerationManifestHash,
    proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      modelCallPerformed: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return {
    ...receipt,
    paperProposalGenerationReceiptHash: hashPaperRecord('PaperProposalGenerationReceipt', receipt),
  };
}

export function buildPaperProposalReviewGate({
  proposalEnvelope,
  generationReceipt,
  approvalVerification = null,
  createdAt = null,
} = {}) {
  if (!proposalEnvelope?.kind || !generationReceipt?.kind) {
    throw new Error('PaperProposalReviewGate requires proposalEnvelope and generationReceipt');
  }
  const blockers = [...(proposalEnvelope.blockers || []), ...(generationReceipt.blockers || [])];
  if (approvalVerification?.status !== 'proposal_approval_verified'
    || approvalVerification?.proposalEnvelopeHash !== proposalEnvelope.paperProposalEnvelopeHash
    || approvalVerification?.generationReceiptHash !== generationReceipt.paperProposalGenerationReceiptHash) {
    blockers.push('proposal_approval_authority_required');
  }
  const gate = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperProposalReviewGate',
    paperId: proposalEnvelope.paperId || null,
    status: blockers.length ? 'proposal_review_blocked' : 'proposal_approved_for_production_plan',
    approved: approvalVerification?.status === 'proposal_approval_verified' && blockers.length === 0,
    proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
    generationReceiptHash: generationReceipt.paperProposalGenerationReceiptHash,
    approvalDocumentHash: approvalVerification?.approvalDocumentHash || null,
    approvalVerificationReceiptHash: approvalVerification?.paperProposalApprovalVerificationReceiptHash || null,
    approvedOperatorSubjectId: approvalVerification?.operatorIdentity?.subjectId || null,
    requiredOperatorInputs: [
      'ed25519_signed_proposal_approval_document',
      'proposal_envelope_hash_binding',
      'generation_receipt_hash_binding',
      'target_venue_binding',
      'all_contribution_claim_hashes',
      'paper_quality_profiles',
      'risk_acceptance_with_rationale',
      'trusted_operator_identity',
      'signed_validity_window',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      operatorGate: true,
      createsPaperTask: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...gate, paperProposalReviewGateHash: hashPaperRecord('PaperProposalReviewGate', gate) };
}

export function createPaperProductionPlanEnvelope({
  proposalEnvelope,
  reviewGate,
  createdAt = null,
} = {}) {
  if (!proposalEnvelope?.kind || !reviewGate?.kind) {
    throw new Error('PaperProductionPlanEnvelope requires proposalEnvelope and reviewGate');
  }
  const blockers = [];
  if (reviewGate.status !== 'proposal_approved_for_production_plan') {
    blockers.push('proposal_review_gate_not_approved');
  }
  const proposal = proposalEnvelope.proposal || {};
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperProductionPlanEnvelope',
    paperId: proposalEnvelope.paperId || null,
    status: blockers.length ? 'draft_plan_waiting_for_proposal_approval' : 'production_plan_ready',
    proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
    reviewGateHash: reviewGate.paperProposalReviewGateHash,
    plannedContracts: [
      'PaperTask',
      'ManuscriptSource',
      'PaperWorkflowState',
      'ClaimScopeContract',
      'ProofObligationContract',
      'EvidenceMatrixContract',
      'ReproducibilityContract',
      'PaperArtifactPackage',
      'VenueSubmissionPlan',
      'PaperActionManifest',
    ],
    productionSteps: [
      'create_paper_task_after_approval',
      'materialize_source_skeleton_or_bind_existing_source',
      'extract_claim_scope',
      'draft_proof_obligations',
      'build_evidence_matrix',
      'prepare_reproducibility_plan',
      'build_package',
      'run_local_dry_run_submission_lifecycle',
    ],
    expectedArtifacts: proposal.requiredArtifacts || [],
    recommendedPaperQualityProfiles: proposal.recommendedPaperQualityProfiles || [],
    gatePlan: [
      ...((proposal.contributionClaims || []).length ? ['claim_scope_gate'] : []),
      ...((proposal.proofObligations || []).length ? ['proof_obligation_gate'] : []),
      ...((proposal.evidencePlan || []).length ? ['evidence_matrix_gate'] : []),
      ...((proposal.recommendedPaperQualityProfiles || []).length ? ['paper_quality_profile_gate'] : []),
      'venue_fit_gate',
      'proposal_approval_gate',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      draftOnlyUntilApproved: blockers.length > 0,
      createsPaperTask: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return {
    ...plan,
    paperProductionPlanEnvelopeHash: hashPaperRecord('PaperProductionPlanEnvelope', plan),
  };
}

export function createManuscriptSourceContract({
  proposalEnvelope,
  productionPlanEnvelope,
  sourceWorkspace = null,
  mainTex = null,
  outline = [],
  createdArtifacts = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!proposalEnvelope?.kind || !productionPlanEnvelope?.kind) {
    throw new Error('ManuscriptSourceContract requires proposalEnvelope and productionPlanEnvelope');
  }
  const contractBlockers = [...(blockers || [])];
  if (productionPlanEnvelope.status !== 'production_plan_ready') {
    contractBlockers.push('production_plan_not_ready');
  }
  if (!sourceWorkspace) contractBlockers.push('source_workspace_missing');
  if (!mainTex) contractBlockers.push('main_tex_missing');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'ManuscriptSourceContract',
    paperId: proposalEnvelope.paperId || null,
    title: proposalEnvelope.title || null,
    status: contractBlockers.length ? 'blocked_manuscript_source' : 'manuscript_source_skeleton_ready',
    proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
    productionPlanEnvelopeHash: productionPlanEnvelope.paperProductionPlanEnvelopeHash,
    sourceWorkspace: normalizeText(sourceWorkspace) || null,
    mainTex: normalizeText(mainTex) || null,
    outline: normalizeList(outline, 32),
    createdArtifacts: normalizeRefs(createdArtifacts),
    blockers: uniqueStrings(contractBlockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      generatedSkeletonOnly: true,
      writesLegacySource: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...contract, manuscriptSourceContractHash: hashPaperRecord('ManuscriptSourceContract', contract) };
}

export function buildPaperTaskCreationEnvelope({
  proposalEnvelope,
  productionPlanEnvelope,
  manuscriptSourceContract,
  paperTask,
  createdAt = null,
} = {}) {
  if (!proposalEnvelope?.kind || !productionPlanEnvelope?.kind || !manuscriptSourceContract?.kind) {
    throw new Error('PaperTaskCreationEnvelope requires proposalEnvelope, productionPlanEnvelope, and manuscriptSourceContract');
  }
  const blockers = [];
  if (productionPlanEnvelope.status !== 'production_plan_ready') blockers.push('production_plan_not_ready');
  if (manuscriptSourceContract.status !== 'manuscript_source_skeleton_ready') blockers.push('manuscript_source_not_ready');
  if (!paperTask?.taskHash) blockers.push('paper_task_draft_missing');
  const envelope = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperTaskCreationEnvelope',
    paperId: proposalEnvelope.paperId || null,
    status: blockers.length ? 'blocked_paper_task_creation' : 'paper_task_draft_ready',
    proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
    productionPlanEnvelopeHash: productionPlanEnvelope.paperProductionPlanEnvelopeHash,
    manuscriptSourceContractHash: manuscriptSourceContract.manuscriptSourceContractHash,
    paperTaskHash: paperTask?.taskHash || null,
    nextCommands: paperTask?.paperId ? [
      `paper-production-core batch-run --mode inventory --paper ${paperTask.paperId}`,
      `paper-production-core batch-run --mode local-build --paper ${paperTask.paperId}`,
      `paper-production-core batch-run --mode local-package --paper ${paperTask.paperId}`,
    ] : [],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      draftOnly: true,
      writesRegistry: false,
      writesLegacySource: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...envelope, paperTaskCreationEnvelopeHash: hashPaperRecord('PaperTaskCreationEnvelope', envelope) };
}

export function createPaperProposalStagingRecord({
  proposalEnvelope,
  productionPlanEnvelope,
  approvalVerification,
  manuscriptSourceContract,
  paperTaskCreationEnvelope,
  paperTask,
  seedContractBundle = null,
  stagingPath = null,
  blockers = [],
  createdAt = null,
} = {}) {
  if (!proposalEnvelope?.kind || !productionPlanEnvelope?.kind) {
    throw new Error('PaperProposalStagingRecord requires proposalEnvelope and productionPlanEnvelope');
  }
  const recordBlockers = [...(blockers || [])];
  if (productionPlanEnvelope.status !== 'production_plan_ready') recordBlockers.push('production_plan_not_ready');
  if (approvalVerification?.status !== 'proposal_approval_verified'
    || approvalVerification?.proposalEnvelopeHash !== proposalEnvelope.paperProposalEnvelopeHash) {
    recordBlockers.push('proposal_approval_verification_required_for_staging');
  }
  if (!manuscriptSourceContract?.kind) {
    recordBlockers.push('manuscript_source_contract_missing');
  } else if (manuscriptSourceContract.status !== 'manuscript_source_skeleton_ready') {
    recordBlockers.push('manuscript_source_not_ready');
  }
  if (paperTaskCreationEnvelope?.status !== 'paper_task_draft_ready') recordBlockers.push('paper_task_creation_not_ready');
  if (!paperTask?.taskHash) recordBlockers.push('paper_task_draft_missing');
  const record = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperProposalStagingRecord',
    paperId: proposalEnvelope.paperId || paperTask?.paperId || null,
    title: proposalEnvelope.title || paperTask?.title || null,
    status: recordBlockers.length ? 'proposal_staging_blocked' : 'proposal_staged_for_inventory',
    venueTarget: paperTask?.venueTarget || null,
    paperType: paperTask?.paperType || null,
    sourceWorkspace: manuscriptSourceContract?.sourceWorkspace || paperTask?.sourceWorkspace || null,
    mainTex: manuscriptSourceContract?.mainTex || paperTask?.mainTex || null,
    stagingPath: normalizeText(stagingPath) || null,
    proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
    productionPlanEnvelopeHash: productionPlanEnvelope.paperProductionPlanEnvelopeHash,
    approvalDocumentHash: approvalVerification?.approvalDocumentHash || null,
    approvalVerificationReceiptHash:
      approvalVerification?.paperProposalApprovalVerificationReceiptHash || null,
    approvedOperatorSubjectId: approvalVerification?.operatorIdentity?.subjectId || null,
    manuscriptSourceContractHash: manuscriptSourceContract?.manuscriptSourceContractHash || null,
    paperTaskCreationEnvelopeHash: paperTaskCreationEnvelope?.paperTaskCreationEnvelopeHash || null,
    paperTaskHash: paperTask?.taskHash || null,
    proposalSeedContractBundleHash: seedContractBundle?.paperProposalSeedContractBundleHash || null,
    seedContractStatus: seedContractBundle?.status || null,
    blockers: uniqueStrings(recordBlockers, 32),
    safety: {
      stagingOnly: true,
      writesProductionRegistry: false,
      writesLegacySource: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || null,
  };
  return { ...record, paperProposalStagingRecordHash: hashPaperRecord('PaperProposalStagingRecord', record) };
}
