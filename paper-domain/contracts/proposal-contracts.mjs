import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { PAPER_CORE_VERSION, hashPaperRecord, normalizeRefs } from './primitives.mjs';
import { PAPER_ACTIONS } from './product-profile.mjs';

function normalizeList(values = [], limit = 32) {
  if (typeof values === 'string') return uniqueStrings(values.split(/\n|;/), limit);
  return uniqueStrings(values || [], limit);
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
    createdAt: createdAt || nowIso(),
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
    createdAt: createdAt || nowIso(),
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
  const normalizedProposal = {
    tentativeTitle: normalizeText(proposal?.tentativeTitle || ideaBrief.title || ideaBrief.idea.slice(0, 96)),
    abstract: normalizeText(proposal?.abstract || ''),
    centralThesis: normalizeText(proposal?.centralThesis || ideaBrief.idea),
    contributionClaims: normalizeList(proposal?.contributionClaims || [], 12),
    expectedStructure: normalizeList(proposal?.expectedStructure || [], 16),
    proofObligations: normalizeList(proposal?.proofObligations || [], 16),
    evidencePlan: normalizeList(proposal?.evidencePlan || [], 16),
    reproducibilityPlan: normalizeList(proposal?.reproducibilityPlan || [], 16),
    venueFit: normalizeText(proposal?.venueFit || ''),
    noveltyRisk: normalizeText(proposal?.noveltyRisk || 'needs_literature_scan'),
    feasibilityRisk: normalizeText(proposal?.feasibilityRisk || 'needs_manual_review'),
    requiredArtifacts: normalizeList(proposal?.requiredArtifacts || [], 16),
  };
  if (!normalizedProposal.abstract) blockers.push('proposal_abstract_missing');
  if (!normalizedProposal.contributionClaims.length) blockers.push('proposal_claims_missing');
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
    warnings: uniqueStrings(proposal?.warnings || [], 32),
    safety: {
      draftOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
    createdAt: createdAt || nowIso(),
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
    createdAt: createdAt || nowIso(),
  };
  return {
    ...receipt,
    paperProposalGenerationReceiptHash: hashPaperRecord('PaperProposalGenerationReceipt', receipt),
  };
}

export function buildPaperProposalReviewGate({
  proposalEnvelope,
  generationReceipt,
  approved = false,
  createdAt = null,
} = {}) {
  if (!proposalEnvelope?.kind || !generationReceipt?.kind) {
    throw new Error('PaperProposalReviewGate requires proposalEnvelope and generationReceipt');
  }
  const blockers = [...(proposalEnvelope.blockers || []), ...(generationReceipt.blockers || [])];
  if (!approved) blockers.push('explicit_proposal_approval_required');
  const gate = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperProposalReviewGate',
    paperId: proposalEnvelope.paperId || null,
    status: blockers.length ? 'proposal_review_blocked' : 'proposal_approved_for_production_plan',
    approved: Boolean(approved) && blockers.length === 0,
    proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
    generationReceiptHash: generationReceipt.paperProposalGenerationReceiptHash,
    requiredOperatorInputs: [
      'approval_decision',
      'target_venue_confirmation',
      'claim_scope_acceptance',
      'risk_acceptance',
      'operator_id',
      'decision_timestamp',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      operatorGate: true,
      createsPaperTask: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
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
    gatePlan: [
      ...((proposal.contributionClaims || []).length ? ['claim_scope_gate'] : []),
      ...((proposal.proofObligations || []).length ? ['proof_obligation_gate'] : []),
      ...((proposal.evidencePlan || []).length ? ['evidence_matrix_gate'] : []),
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
    createdAt: createdAt || nowIso(),
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
    createdAt: createdAt || nowIso(),
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
    createdAt: createdAt || nowIso(),
  };
  return { ...envelope, paperTaskCreationEnvelopeHash: hashPaperRecord('PaperTaskCreationEnvelope', envelope) };
}

export function createPaperProposalStagingRecord({
  proposalEnvelope,
  productionPlanEnvelope,
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
    createdAt: createdAt || nowIso(),
  };
  return { ...record, paperProposalStagingRecordHash: hashPaperRecord('PaperProposalStagingRecord', record) };
}
