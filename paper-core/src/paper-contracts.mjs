import { digest } from '../../core/src/hash-utils.mjs';
import { normalizeText, nowIso, uniqueStrings } from './utils.mjs';

export const PAPER_CORE_VERSION = 1;

export const PAPER_CHANNEL_IDS = Object.freeze({
  PAPER_FACTORY: 'paper_factory',
});

export const PAPER_PRODUCT_IDS = Object.freeze({
  MANUSCRIPT_PRODUCTION: 'paper_manuscript_production',
});

export const PAPER_OUTPUT_MODES = Object.freeze({
  MANUSCRIPT_PACKAGE: 'manuscript_package',
  VENUE_HANDOFF: 'venue_handoff',
});

export const PAPER_ACTIONS = Object.freeze({
  INVENTORY_SCAN: 'paper.inventory.scan',
  PROPOSAL_GENERATE: 'paper.proposal.generate',
  LATEX_BUILD: 'paper.latex.build',
  SOURCE_PACKAGE: 'paper.source.package',
  RESEARCH_VERIFY: 'paper.research.verify',
  REFEREE_REVISE: 'paper.referee.revise',
  VENUE_DRY_RUN: 'paper.venue.dry_run',
  REVIEWED_SUBMIT: 'paper.venue.reviewed_submit',
});

export const PAPER_WORKFLOW_STAGES = Object.freeze({
  INVENTORY_READY: 'inventory_ready',
  SOURCE_READY: 'source_ready',
  BUILD_READY: 'build_ready',
  RESEARCH_VERIFIED: 'research_verified',
  PACKAGE_READY: 'package_ready',
  READINESS_GATE_READY: 'readiness_gate_ready',
  HANDOFF_READY: 'handoff_ready',
  SUBMITTED_VERIFIED: 'submitted_verified',
  BLOCKED: 'blocked',
});

export const PAPER_MANIFEST_STATUS = Object.freeze({
  READY: 'ready_for_adapter',
  BLOCKED: 'blocked_manifest',
});

export const PAPER_RUN_RECEIPT_STATUS = Object.freeze({
  DRY_RUN_RECORDED: 'dry_run_recorded',
  BLOCKED: 'blocked_run',
});

export const PAPER_PRODUCT_PROFILE = Object.freeze({
  version: PAPER_CORE_VERSION,
  productLineId: PAPER_PRODUCT_IDS.MANUSCRIPT_PRODUCTION,
  workflowId: 'paper_production',
  label: 'Paper production',
  defaultOutputMode: PAPER_OUTPUT_MODES.MANUSCRIPT_PACKAGE,
  channelPolicy: {
    supportedChannels: [PAPER_CHANNEL_IDS.PAPER_FACTORY],
    externalSubmissionBlockedUntilReviewedApproval: true,
    directExternalActionsBlocked: [PAPER_ACTIONS.REVIEWED_SUBMIT],
  },
  requiredGates: [
    'paper_inventory',
    'source_workspace_binding',
    'latex_build_or_existing_pdf',
    'typed_claim_scope_contract',
    'typed_proof_obligation_contract',
    'typed_evidence_matrix_contract',
    'reproducibility_contract',
    'research_claim_evidence_scan',
    'source_package_hash',
    'venue_submission_plan',
    'fresh_venue_evidence_bundle',
    'submission_replay_guard',
    'fresh_local_dry_run_receipt',
    'explicit_reviewed_submit_approval',
  ],
  qualityGates: [
    'main_tex_discovered',
    'compiled_pdf_or_build_plan',
    'source_zip_or_package_plan',
    'claim_evidence_or_manual_review',
    'venue_metadata_resolved',
  ],
  safety: {
    importsOldControlPlane: false,
    executesExternalSubmission: false,
    writesInsideLegacyPaperFactory: false,
  },
});

function normalizedId(value, fallback) {
  return normalizeText(value) || fallback;
}

function normalizeRefs(values = []) {
  return (values || []).map((item) => {
    if (typeof item === 'string') return { kind: 'path', ref: normalizeText(item) };
    return {
      kind: normalizeText(item?.kind || 'path') || 'path',
      ref: normalizeText(item?.ref || item?.path || item?.url || item?.id || ''),
      hash: normalizeText(item?.hash || '') || null,
      notes: normalizeText(item?.notes || '') || null,
    };
  }).filter((item) => item.ref);
}

export function hashPaperRecord(kind, payload = {}) {
  return digest({ version: PAPER_CORE_VERSION, kind, payload });
}

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

function normalizeContractItems(values = [], fallbackPrefix = 'item', limit = 64) {
  return (values || []).slice(0, limit).map((item, index) => {
    if (typeof item === 'string') {
      return {
        id: `${fallbackPrefix}:${index + 1}`,
        text: normalizeText(item),
        status: 'observed',
        evidenceRefs: [],
      };
    }
    return {
      id: normalizedId(item?.id || item?.key || item?.claim_id || item?.obligation_id, `${fallbackPrefix}:${index + 1}`),
      text: normalizeText(item?.text || item?.claim || item?.obligation || item?.description || ''),
      status: normalizeText(item?.status || item?.state || 'observed') || 'observed',
      kind: normalizeText(item?.kind || item?.type || '') || null,
      evidenceRefs: normalizeRefs(item?.evidenceRefs || item?.evidence_refs || item?.evidence || []),
      sourceLocator: normalizeText(item?.sourceLocator || item?.source_locator || item?.locator || '') || null,
    };
  }).filter((item) => item.text || item.sourceLocator || item.evidenceRefs.length);
}

export function createClaimScopeContract({
  paperTask,
  claims = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('ClaimScopeContract requires paperTask');
  const normalizedClaims = normalizeContractItems(claims, `${paperTask.paperId}:claim`, 96);
  const contractBlockers = [...(blockers || [])];
  const contractWarnings = [...(warnings || [])];
  if (!normalizedClaims.length) contractWarnings.push('claim_scope_requires_manual_extraction');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'ClaimScopeContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: contractBlockers.length ? 'blocked_claim_scope' : (normalizedClaims.length ? 'claim_scope_detected' : 'manual_claim_scope_needed'),
    claimCount: normalizedClaims.length,
    claims: normalizedClaims,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(contractBlockers, 32),
    warnings: uniqueStrings(contractWarnings, 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...contract, claimScopeContractHash: hashPaperRecord('ClaimScopeContract', contract) };
}

export function createProofObligationContract({
  paperTask,
  obligations = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('ProofObligationContract requires paperTask');
  const normalizedObligations = normalizeContractItems(obligations, `${paperTask.paperId}:proof`, 96);
  const contractWarnings = [...(warnings || [])];
  if (!normalizedObligations.length) contractWarnings.push('proof_obligations_require_manual_review');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'ProofObligationContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'blocked_proof_obligations' : (normalizedObligations.length ? 'proof_obligations_detected' : 'manual_proof_review_needed'),
    proofObligationCount: normalizedObligations.length,
    obligations: normalizedObligations,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(contractWarnings, 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      claimsMachineCheckedProof: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...contract, proofObligationContractHash: hashPaperRecord('ProofObligationContract', contract) };
}

export function createEvidenceMatrixContract({
  paperTask,
  evidenceItems = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('EvidenceMatrixContract requires paperTask');
  const normalizedEvidence = normalizeContractItems(evidenceItems, `${paperTask.paperId}:evidence`, 160);
  const contractWarnings = [...(warnings || [])];
  if (!normalizedEvidence.length && !(evidenceRefs || []).length) contractWarnings.push('evidence_matrix_empty');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'EvidenceMatrixContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'blocked_evidence_matrix' : (normalizedEvidence.length || (evidenceRefs || []).length ? 'evidence_matrix_present' : 'manual_evidence_review_needed'),
    evidenceItemCount: normalizedEvidence.length,
    evidenceItems: normalizedEvidence,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(contractWarnings, 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...contract, evidenceMatrixContractHash: hashPaperRecord('EvidenceMatrixContract', contract) };
}

export function createReproducibilityContract({
  paperTask,
  artifacts = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('ReproducibilityContract requires paperTask');
  const normalizedArtifacts = normalizeContractItems(artifacts, `${paperTask.paperId}:repro`, 96);
  const contractWarnings = [...(warnings || [])];
  if (!normalizedArtifacts.length) contractWarnings.push('reproducibility_contract_requires_manual_review');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'ReproducibilityContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'blocked_reproducibility' : (normalizedArtifacts.length ? 'reproducibility_evidence_present' : 'manual_reproducibility_review_needed'),
    reproducibilityItemCount: normalizedArtifacts.length,
    artifacts: normalizedArtifacts,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(contractWarnings, 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...contract, reproducibilityContractHash: hashPaperRecord('ReproducibilityContract', contract) };
}

export function buildPaperResearchVerifyReceipt({
  paperTask,
  claimScopeContract,
  proofObligationContract,
  evidenceMatrixContract,
  reproducibilityContract,
  workerReceipts = [],
  evidenceRefs = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperResearchVerifyReceipt requires paperTask');
  const receiptBlockers = [
    ...(blockers || []),
    ...(claimScopeContract?.blockers || []),
    ...(proofObligationContract?.blockers || []),
    ...(evidenceMatrixContract?.blockers || []),
    ...(reproducibilityContract?.blockers || []),
  ];
  const typedContracts = {
    claimScopeContractHash: claimScopeContract?.claimScopeContractHash || null,
    proofObligationContractHash: proofObligationContract?.proofObligationContractHash || null,
    evidenceMatrixContractHash: evidenceMatrixContract?.evidenceMatrixContractHash || null,
    reproducibilityContractHash: reproducibilityContract?.reproducibilityContractHash || null,
    workerReceiptHashes: (workerReceipts || [])
      .map((receipt) => receipt.paperResearchWorkerBridgeReceiptHash)
      .filter(Boolean),
  };
  const observedEvidenceCount = normalizeRefs(evidenceRefs).length
    + Number(evidenceMatrixContract?.evidenceItemCount || 0)
    + Number(reproducibilityContract?.reproducibilityItemCount || 0);
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperResearchVerifyReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: receiptBlockers.length ? 'blocked' : (observedEvidenceCount ? 'evidence_present' : 'manual_review_needed'),
    typedContracts,
    observedEvidenceCount,
    evidenceRefs: normalizeRefs(evidenceRefs),
    blockers: uniqueStrings(receiptBlockers, 32),
    warnings: uniqueStrings([
      ...(warnings || []),
      ...(claimScopeContract?.warnings || []),
      ...(proofObligationContract?.warnings || []),
      ...(evidenceMatrixContract?.warnings || []),
      ...(reproducibilityContract?.warnings || []),
    ], 64),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      claimsMachineCheckedProof: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...receipt, researchVerifyReceiptHash: hashPaperRecord('PaperResearchVerifyReceipt', receipt) };
}

export function buildPaperResearchWorkerBridgeReceipt({
  paperTask,
  worker,
  role,
  contractHashes = {},
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !worker?.path) throw new Error('PaperResearchWorkerBridgeReceipt requires paperTask and worker');
  const normalizedEvidenceRefs = normalizeRefs(evidenceRefs);
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperResearchWorkerBridgeReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    workerId: normalizeText(worker.id || worker.filename || worker.path),
    workerPath: normalizeText(worker.path),
    workerHash: normalizeText(worker.hash || '') || null,
    role: normalizeText(role || worker.role || 'evidence') || 'evidence',
    status: normalizedEvidenceRefs.length ? 'worker_bridge_evidence_bound' : 'worker_bridge_available_no_evidence',
    executionMode: 'discovery_only_no_import_no_execute',
    contractHashes: {
      claimScopeContractHash: contractHashes.claimScopeContractHash || null,
      proofObligationContractHash: contractHashes.proofObligationContractHash || null,
      evidenceMatrixContractHash: contractHashes.evidenceMatrixContractHash || null,
      reproducibilityContractHash: contractHashes.reproducibilityContractHash || null,
    },
    evidenceRefs: normalizedEvidenceRefs,
    safety: {
      importsOldControlPlane: false,
      executesWorker: false,
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      claimsMachineCheckedProof: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...receipt,
    paperResearchWorkerBridgeReceiptHash: hashPaperRecord('PaperResearchWorkerBridgeReceipt', receipt),
  };
}

export function createPaperTask({
  paperId,
  title = null,
  status = null,
  venueTarget = null,
  paperType = null,
  canonicalDir = null,
  sourceWorkspace = null,
  mainTex = null,
  registry = null,
  source = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  const id = normalizeText(paperId);
  if (!id) throw new Error('PaperTask requires paperId');
  const task = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperTask',
    channelId: PAPER_CHANNEL_IDS.PAPER_FACTORY,
    productLineId: PAPER_PRODUCT_IDS.MANUSCRIPT_PRODUCTION,
    workflowId: PAPER_PRODUCT_PROFILE.workflowId,
    paperId: id,
    taskKey: `${PAPER_CHANNEL_IDS.PAPER_FACTORY}:${id}`,
    title: normalizeText(title) || id,
    status: normalizeText(status) || null,
    venueTarget: normalizeText(venueTarget) || null,
    paperType: normalizeText(paperType) || null,
    canonicalDir: normalizeText(canonicalDir) || null,
    sourceWorkspace: normalizeText(sourceWorkspace) || null,
    mainTex: normalizeText(mainTex) || null,
    registry: registry || null,
    source: source || null,
    evidenceRefs: normalizeRefs(evidenceRefs),
    createdAt: createdAt || nowIso(),
  };
  return { ...task, taskHash: hashPaperRecord('PaperTask', task) };
}

export function createPaperBuildArtifactAcceptance({
  paperTask,
  execute = false,
  command = [],
  buildDir = null,
  sourceWorkspace = null,
  mainTex = null,
  builtPdf = null,
  execution = null,
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperBuildArtifactAcceptance requires paperTask');
  const acceptanceBlockers = [...(blockers || [])];
  if (execute && !builtPdf?.hash) acceptanceBlockers.push('compiled_pdf_missing_after_build');
  const status = acceptanceBlockers.length
    ? 'build_artifact_acceptance_blocked'
    : execute
      ? 'compiled_pdf_accepted_for_local_package'
      : 'build_artifact_acceptance_dry_run_only';
  const acceptance = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperBuildArtifactAcceptance',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status,
    accepted: status === 'compiled_pdf_accepted_for_local_package',
    execute: Boolean(execute),
    command: (command || []).map((part) => normalizeText(part)),
    buildDir: normalizeText(buildDir) || null,
    sourceWorkspace: normalizeText(sourceWorkspace || paperTask.sourceWorkspace) || null,
    mainTex: normalizeText(mainTex || paperTask.mainTex) || null,
    builtPdf: builtPdf ? {
      role: normalizeText(builtPdf.role || 'compiled_pdf') || 'compiled_pdf',
      path: normalizeText(builtPdf.path),
      filename: normalizeText(builtPdf.filename),
      sizeBytes: Number.isFinite(Number(builtPdf.sizeBytes)) ? Number(builtPdf.sizeBytes) : null,
      hash: normalizeText(builtPdf.hash) || null,
    } : null,
    execution: execution ? {
      executed: Boolean(execution.executed),
      status: Number.isFinite(Number(execution.status)) ? Number(execution.status) : null,
      signal: normalizeText(execution.signal) || null,
    } : null,
    blockers: uniqueStrings(acceptanceBlockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      localBuildOnly: true,
      outputUnderRuntime: true,
      sourceMutation: false,
      externalActionPerformed: false,
      acceptsForLiveSubmit: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...acceptance,
    paperBuildArtifactAcceptanceHash: hashPaperRecord('PaperBuildArtifactAcceptance', acceptance),
  };
}

export function createPaperArtifactPackage({
  paperTask,
  mode = 'local-package',
  artifacts = [],
  packageStatus = 'package_unknown',
  buildStatus = 'build_unknown',
  submitReady = false,
  provenance = null,
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperArtifactPackage requires paperTask');
  const normalizedArtifacts = (artifacts || []).map((artifact, index) => ({
    id: normalizedId(artifact.id, `${paperTask.paperId}:artifact:${index + 1}`),
    role: normalizeText(artifact.role || 'artifact') || 'artifact',
    filename: normalizeText(artifact.filename || artifact.name || ''),
    path: normalizeText(artifact.path || '') || null,
    mimeType: normalizeText(artifact.mimeType || '') || null,
    sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : null,
    hash: normalizeText(artifact.hash || '') || null,
    source: normalizeText(artifact.source || '') || null,
  })).filter((artifact) => artifact.filename || artifact.path);
  const pkg = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperArtifactPackage',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    channelId: paperTask.channelId,
    productLineId: paperTask.productLineId,
    workflowId: paperTask.workflowId,
    outputMode: PAPER_OUTPUT_MODES.MANUSCRIPT_PACKAGE,
    mode: normalizeText(mode) || 'local-package',
    packageStatus: normalizeText(packageStatus) || 'package_unknown',
    buildStatus: normalizeText(buildStatus) || 'build_unknown',
    artifactCount: normalizedArtifacts.length,
    artifacts: normalizedArtifacts,
    submitReady: Boolean(submitReady),
    provenance: provenance || {
      generatedByPaperCore: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    evidenceRefs: normalizeRefs(evidenceRefs),
    createdAt: createdAt || nowIso(),
  };
  return { ...pkg, artifactPackageHash: hashPaperRecord('PaperArtifactPackage', pkg) };
}

export function createPaperWorkflowState({
  paperTask,
  draftStatus,
  compileStatus,
  researchVerifyStatus,
  packageStatus,
  readinessStatus,
  runnerStatus = 'not_started',
  submissionStatus = 'not_started',
  nextAction = null,
  autoLevel = null,
  stage = null,
  submissionIntent = null,
  blockers = [],
  warnings = [],
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperWorkflowState requires paperTask');
  const state = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperWorkflowState',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    venue: paperTask.venueTarget || null,
    sourceWorkspace: paperTask.sourceWorkspace || null,
    draftStatus: normalizeText(draftStatus) || 'unknown',
    compileStatus: normalizeText(compileStatus) || 'unknown',
    researchVerifyStatus: normalizeText(researchVerifyStatus) || 'unknown',
    packageStatus: normalizeText(packageStatus) || 'unknown',
    readinessStatus: normalizeText(readinessStatus) || 'unknown',
    runnerStatus: normalizeText(runnerStatus) || 'not_started',
    submissionStatus: normalizeText(submissionStatus) || 'not_started',
    nextAction: normalizeText(nextAction) || null,
    autoLevel: normalizeText(autoLevel) || null,
    stage: normalizeText(stage) || null,
    submissionIntent: submissionIntent || null,
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    evidenceRefs: normalizeRefs(evidenceRefs),
    createdAt: createdAt || nowIso(),
  };
  return { ...state, stateHash: hashPaperRecord('PaperWorkflowState', state) };
}

export function paperWorkflowRow(state) {
  return {
    paper_id: state.paperId,
    venue: state.venue || '',
    source_workspace: state.sourceWorkspace || '',
    draft_status: state.draftStatus,
    compile_status: state.compileStatus,
    research_verify_status: state.researchVerifyStatus,
    package_status: state.packageStatus,
    readiness_status: state.readinessStatus,
    runner_status: state.runnerStatus,
    submission_status: state.submissionStatus,
    next_action: state.nextAction || '',
    auto_level: state.autoLevel || '',
    submission_intent: state.submissionIntent?.status || '',
    production_disposition: state.submissionIntent?.disposition || '',
  };
}

export function inferPaperStage(state) {
  if (state.blockers?.length) return PAPER_WORKFLOW_STAGES.BLOCKED;
  if (state.submissionStatus === 'venue_state_proof_recorded') return PAPER_WORKFLOW_STAGES.SUBMITTED_VERIFIED;
  if (state.runnerStatus === 'dry_run_receipt_recorded') return PAPER_WORKFLOW_STAGES.HANDOFF_READY;
  if (state.readinessStatus === 'ready_for_local_dry_run') return PAPER_WORKFLOW_STAGES.READINESS_GATE_READY;
  if (state.packageStatus === 'package_present' || state.packageStatus === 'package_ready') return PAPER_WORKFLOW_STAGES.PACKAGE_READY;
  if (state.researchVerifyStatus === 'verified' || state.researchVerifyStatus === 'evidence_present') return PAPER_WORKFLOW_STAGES.RESEARCH_VERIFIED;
  if (state.compileStatus === 'compiled_pdf_present' || state.compileStatus === 'build_ready') return PAPER_WORKFLOW_STAGES.BUILD_READY;
  if (state.draftStatus === 'source_tex_present') return PAPER_WORKFLOW_STAGES.SOURCE_READY;
  if (state.draftStatus === 'source_present') return PAPER_WORKFLOW_STAGES.INVENTORY_READY;
  return PAPER_WORKFLOW_STAGES.BLOCKED;
}

export function nextActionForState(state) {
  const blockerSet = new Set(state.blockers || []);
  if (state.draftStatus === 'missing_source') return PAPER_ACTIONS.INVENTORY_SCAN;
  if (state.draftStatus !== 'source_tex_present') return 'paper.source.adapt';
  if (!['compiled_pdf_present', 'build_ready', 'build_passed'].includes(state.compileStatus)) {
    return PAPER_ACTIONS.LATEX_BUILD;
  }
  if (!['verified', 'evidence_present', 'proposal_seed_present', 'manual_review_only'].includes(state.researchVerifyStatus)) {
    return PAPER_ACTIONS.RESEARCH_VERIFY;
  }
  if (!['package_present', 'package_ready'].includes(state.packageStatus)) return PAPER_ACTIONS.SOURCE_PACKAGE;
  if (blockerSet.has('venue_target_missing') || blockerSet.has('venue_submission_plan_not_ready')) {
    return 'paper.venue.resolve';
  }
  if (blockerSet.has('artifact_package_not_submit_ready')) return PAPER_ACTIONS.SOURCE_PACKAGE;
  if (blockerSet.has('live_submit_not_implemented_in_overlay') || blockerSet.has('explicit_reviewed_submit_approval_required')) {
    return PAPER_ACTIONS.REVIEWED_SUBMIT;
  }
  if (state.readinessStatus !== 'ready_for_local_dry_run') return 'paper.readiness.gate';
  if (state.runnerStatus !== 'dry_run_receipt_recorded') return PAPER_ACTIONS.VENUE_DRY_RUN;
  return PAPER_ACTIONS.REVIEWED_SUBMIT;
}

export function autoLevelForState(state) {
  const blockerSet = new Set(state.blockers || []);
  if (state.draftStatus === 'missing_source') return 'inventory_only';
  if (state.draftStatus !== 'source_tex_present') return 'source_adapt_needed';
  if (!['compiled_pdf_present', 'build_ready', 'build_passed'].includes(state.compileStatus)) return 'local_build';
  if (!['package_present', 'package_ready'].includes(state.packageStatus)) return 'local_package';
  if (blockerSet.has('artifact_package_not_submit_ready')) return 'local_package';
  if (blockerSet.has('live_submit_not_implemented_in_overlay') || blockerSet.has('explicit_reviewed_submit_approval_required')) {
    return 'reviewed_submit_blocked';
  }
  if (state.runnerStatus === 'dry_run_receipt_recorded') return 'reviewed_submit_blocked';
  return 'local_dry_run';
}

export function createPaperActionManifest({
  paperTask,
  action,
  mode = 'local-dry-run',
  artifactPackage = null,
  researchReport = null,
  venuePlan = null,
  venueEvidenceBundle = null,
  dryRun = true,
  approvalPacket = null,
  extraBlockers = [],
  evidenceRefs = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('PaperActionManifest requires paperTask');
  const normalizedAction = normalizeText(action);
  const blockers = [];
  const warnings = [];
  if (!Object.values(PAPER_ACTIONS).includes(normalizedAction)) blockers.push('unknown_paper_action');
  if (normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT) {
    if (!approvalPacket?.approved) blockers.push('explicit_reviewed_submit_approval_required');
  }
  if (normalizedAction !== PAPER_ACTIONS.INVENTORY_SCAN && !paperTask.sourceWorkspace) {
    blockers.push('source_workspace_required');
  }
  if ([PAPER_ACTIONS.VENUE_DRY_RUN, PAPER_ACTIONS.REVIEWED_SUBMIT].includes(normalizedAction)) {
    if (!artifactPackage?.submitReady) blockers.push('artifact_package_not_submit_ready');
    if (researchReport?.status === 'blocked') blockers.push('research_verify_blocked');
    if (venuePlan?.status !== 'local_dry_run_ready') blockers.push('venue_submission_plan_not_ready');
  }
  blockers.push(...(extraBlockers || []));
  const manifest = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperActionManifest',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    channelId: paperTask.channelId,
    productLineId: paperTask.productLineId,
    workflowId: paperTask.workflowId,
    action: normalizedAction,
    mode: normalizeText(mode) || 'local-dry-run',
    status: blockers.length ? PAPER_MANIFEST_STATUS.BLOCKED : PAPER_MANIFEST_STATUS.READY,
    readyForAdapter: blockers.length === 0,
    adapter: {
      runnerId: 'hepta-paper.paper-adapters',
      actionId: normalizedAction,
      sideEffectClass: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT ? 'external_blocked' : 'local_only',
      dryRun: dryRun !== false,
    },
    payload: {
      paperId: paperTask.paperId,
      title: paperTask.title,
      venueTarget: paperTask.venueTarget || null,
      sourceWorkspace: paperTask.sourceWorkspace || null,
      mainTex: paperTask.mainTex || null,
      artifactPackageHash: artifactPackage?.artifactPackageHash || null,
      artifactHashes: (artifactPackage?.artifacts || []).map((artifact) => artifact.hash).filter(Boolean),
      researchReportHash: researchReport?.researchReportHash || null,
      venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
      freshVenueEvidenceBundleHash: venueEvidenceBundle?.freshVenueEvidenceBundleHash || null,
      approvalHash: approvalPacket?.approvalHash || null,
      externalActionAuthorized: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT && approvalPacket?.approved === true,
      controlledExternalExecutorRequired: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT,
    },
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    evidenceRefs: normalizeRefs(evidenceRefs),
    safety: {
      dryRun: dryRun !== false,
      sourceMutation: false,
      executesExternalAction: false,
      liveSubmitBlocked: false,
      controlledExecutorBoundary: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT,
    },
    createdAt: createdAt || nowIso(),
  };
  const manifestHash = hashPaperRecord('PaperActionManifest', manifest);
  return { ...manifest, manifestHash, hash: manifestHash };
}

export function buildPaperHandoffEnvelope({ manifest, createdAt = null } = {}) {
  if (!manifest?.kind) throw new Error('PaperHandoffEnvelope requires manifest');
  const blocked = manifest.status !== PAPER_MANIFEST_STATUS.READY || !manifest.readyForAdapter;
  const envelope = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperHandoffEnvelope',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blocked ? 'blocked_handoff' : 'dry_run_ready',
    readyForDryRun: !blocked,
    readyForExecution: false,
    manifestHash: manifest.manifestHash,
    commandPreview: [
      'paper-adapter-runner',
      'handoff',
      '--action-id',
      manifest.action,
      '--paper',
      manifest.paperId,
      '--manifest-hash',
      manifest.manifestHash,
      '--dry-run',
    ].join(' '),
    blockers: blocked ? uniqueStrings(manifest.blockers || ['manifest_not_ready'], 32) : [],
    safety: {
      commandPreviewOnly: true,
      executesExternalAction: false,
      sourceMutation: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...envelope, envelopeHash: hashPaperRecord('PaperHandoffEnvelope', envelope) };
}

export function buildPaperAdapterRunReceipt({ envelope, manifest, createdAt = null } = {}) {
  if (!envelope?.kind || !manifest?.kind) throw new Error('PaperAdapterRunReceipt requires envelope and manifest');
  const blocked = envelope.status !== 'dry_run_ready';
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'PaperAdapterRunReceipt',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blocked ? PAPER_RUN_RECEIPT_STATUS.BLOCKED : PAPER_RUN_RECEIPT_STATUS.DRY_RUN_RECORDED,
    result: blocked ? 'blocked' : 'dry_run_success',
    manifestHash: manifest.manifestHash,
    envelopeHash: envelope.envelopeHash,
    externalActionPerformed: false,
    sourceMutationPerformed: false,
    createdAt: createdAt || nowIso(),
  };
  return { ...receipt, receiptHash: hashPaperRecord('PaperAdapterRunReceipt', receipt) };
}

export function buildVenueSubmissionPlan({
  paperTask,
  venue = null,
  artifactPackage = null,
  mode = 'local-dry-run',
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('VenueSubmissionPlan requires paperTask');
  const planBlockers = [...(blockers || [])];
  if (!paperTask.venueTarget && !venue?.name) planBlockers.push('venue_target_missing');
  if (!artifactPackage?.artifactCount) planBlockers.push('artifact_package_missing');
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueSubmissionPlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    venueTarget: paperTask.venueTarget || venue?.name || null,
    venueId: venue?.venue_id || venue?.venueId || null,
    venueKind: venue?.kind || null,
    mode: normalizeText(mode) || 'local-dry-run',
    status: planBlockers.length ? 'blocked_plan' : 'local_dry_run_ready',
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    externalActionAuthorized: false,
    blockers: uniqueStrings(planBlockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      opensPortal: false,
      uploads: false,
      emails: false,
      submits: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...plan, venueSubmissionPlanHash: hashPaperRecord('VenueSubmissionPlan', plan) };
}

export function buildVenueStateProof({ receipt, venuePlan, createdAt = null } = {}) {
  if (!receipt?.kind || !venuePlan?.kind) throw new Error('VenueStateProof requires receipt and venuePlan');
  const blockers = [];
  if (receipt.status !== PAPER_RUN_RECEIPT_STATUS.DRY_RUN_RECORDED) blockers.push('receipt_not_dry_run_recorded');
  if (venuePlan.status !== 'local_dry_run_ready') blockers.push('venue_plan_not_ready');
  if (receipt.externalActionPerformed) blockers.push('unexpected_external_action_performed');
  if (venuePlan.externalActionAuthorized) blockers.push('unexpected_external_authorization');
  const proof = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueStateProof',
    taskKey: receipt.taskKey,
    paperId: receipt.paperId,
    venueSubmissionPlanHash: venuePlan.venueSubmissionPlanHash,
    receiptHash: receipt.receiptHash,
    status: blockers.length ? 'blocked_proof' : 'dry_run_state_proof',
    externalStateChanged: false,
    blockers,
    createdAt: createdAt || nowIso(),
  };
  return { ...proof, venueStateProofHash: hashPaperRecord('VenueStateProof', proof) };
}

export function buildRefereeReviewIntake({
  paperTask,
  sourceRecord = null,
  evidenceRefs = [],
  reviewScope = 'agent_referee_review',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('RefereeReviewIntake requires paperTask');
  const blockers = [];
  const normalizedScope = normalizeText(reviewScope) || 'agent_referee_review';
  if (!paperTask.mainTex) blockers.push('main_tex_required_for_referee_review');
  if (!sourceRecord?.hash) blockers.push('source_record_required_for_referee_review');
  const intake = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeReviewIntake',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    reviewScope: normalizedScope,
    status: blockers.length ? 'referee_review_intake_blocked' : 'referee_review_intake_ready',
    mainTex: paperTask.mainTex || null,
    sourceRecord,
    evidenceRefs: normalizeRefs(evidenceRefs).slice(0, 32),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      readsOnly: true,
      modelCallPerformed: false,
      writesSqlite: false,
      writesSource: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...intake, refereeReviewIntakeHash: hashPaperRecord('RefereeReviewIntake', intake) };
}

export function buildAgentRefereeReviewReport({
  paperTask,
  intake,
  findings = [],
  reviewerId = 'openclaw-agent-referee-reviewer',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !intake?.kind) throw new Error('AgentRefereeReviewReport requires paperTask and intake');
  const blockers = [];
  if (intake.status !== 'referee_review_intake_ready') blockers.push('referee_review_intake_not_ready');
  const normalizedFindings = (findings || []).slice(0, 32).map((finding, index) => {
    const requestKey = normalizeText(finding.requestKey || finding.request_key || finding.id)
      || `${paperTask.paperId}:agent-review:${index + 1}`;
    return {
      id: normalizedId(finding.id || requestKey, `${paperTask.paperId}:agent-review:${index + 1}`),
      requestKey,
      status: normalizeText(finding.status || 'requested') || 'requested',
      severity: normalizeText(finding.severity || 'medium') || 'medium',
      riskClass: normalizeText(finding.riskClass || finding.risk_class || 'agent_referee_review') || 'agent_referee_review',
      objection: normalizeText(finding.objection || ''),
      sourceLocator: normalizeText(finding.sourceLocator || finding.source_locator || '') || null,
      evidenceLocator: normalizeText(finding.evidenceLocator || finding.evidence_locator || '') || null,
      proposedFix: normalizeText(finding.proposedFix || finding.proposed_fix || ''),
      evidenceNeeded: normalizeText(finding.evidenceNeeded || finding.evidence_needed || '') || null,
      verification: normalizeText(finding.verification || ''),
      patchScope: normalizeText(finding.patchScope || finding.patch_scope || 'single_main_tex_repair') || 'single_main_tex_repair',
    };
  }).filter((finding) => finding.objection && finding.proposedFix && finding.verification);
  const report = {
    version: PAPER_CORE_VERSION,
    kind: 'AgentRefereeReviewReport',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    reviewerId: normalizeText(reviewerId) || 'openclaw-agent-referee-reviewer',
    status: blockers.length
      ? 'agent_referee_review_blocked'
      : (normalizedFindings.length ? 'agent_referee_review_ready' : 'agent_referee_review_clear'),
    intakeHash: intake.refereeReviewIntakeHash,
    findingCount: normalizedFindings.length,
    findings: normalizedFindings,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      deterministicLocalReview: true,
      modelCallPerformed: false,
      writesSqlite: false,
      writesSource: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...report, agentRefereeReviewReportHash: hashPaperRecord('AgentRefereeReviewReport', report) };
}

export function buildRefereeIssueQueueMaterialization({
  paperTask,
  reviewReport,
  execute = false,
  sqliteWritePerformed = false,
  materializedIssueRows = [],
  existingIssueRows = [],
  errors = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !reviewReport?.kind) {
    throw new Error('RefereeIssueQueueMaterialization requires paperTask and reviewReport');
  }
  const allBlockers = [...(blockers || [])];
  if (reviewReport.status === 'agent_referee_review_blocked') allBlockers.push('agent_referee_review_not_ready');
  if (execute && reviewReport.status === 'agent_referee_review_ready' && !materializedIssueRows.length && !existingIssueRows.length) {
    allBlockers.push('referee_issue_rows_not_materialized');
  }
  const materialization = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeIssueQueueMaterialization',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: execute ? 'execute' : 'plan',
    status: allBlockers.length
      ? 'referee_issue_queue_materialization_blocked'
      : (!reviewReport.findingCount
        ? 'referee_issue_queue_materialization_not_needed'
        : execute
        ? 'referee_issue_queue_materialized'
        : 'referee_issue_queue_materialization_planned'),
    reviewReportHash: reviewReport.agentRefereeReviewReportHash,
    findingCount: reviewReport.findingCount || 0,
    materializedIssueRows: (materializedIssueRows || []).slice(0, 64).map((row, index) => ({
      id: normalizedId(row.id || row.requestKey || row.request_key || row.requestId, `${paperTask.paperId}:materialized-review:${index + 1}`),
      requestKey: normalizeText(row.requestKey || row.request_key || row.id || ''),
      status: normalizeText(row.status || 'requested') || 'requested',
      action: normalizeText(row.action || 'inserted') || 'inserted',
    })),
    existingIssueRows: (existingIssueRows || []).slice(0, 64).map((row, index) => ({
      id: normalizedId(row.id || row.requestKey || row.request_key || row.requestId, `${paperTask.paperId}:existing-review:${index + 1}`),
      requestKey: normalizeText(row.requestKey || row.request_key || row.id || ''),
      status: normalizeText(row.status || 'requested') || 'requested',
      action: normalizeText(row.action || 'already_present') || 'already_present',
    })),
    blockers: uniqueStrings(allBlockers, 32),
    warnings: uniqueStrings(warnings, 32),
    errors: uniqueStrings(errors, 32),
    safety: {
      writesSqlite: Boolean(execute && sqliteWritePerformed),
      writesSource: false,
      appliesPatch: false,
      externalActionPerformed: false,
      requiresRefereeReviseForSourceMutation: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...materialization,
    refereeIssueQueueMaterializationHash: hashPaperRecord('RefereeIssueQueueMaterialization', materialization),
  };
}

export function buildRefereeRevisionIssueQueue({
  paperTask,
  requests = [],
  patchQueue = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('RefereeRevisionIssueQueue requires paperTask');
  const issues = (requests || []).slice(0, 128).map((request, index) => ({
    id: normalizedId(request.request_key || request.requestId || request.id, `${paperTask.paperId}:referee:${index + 1}`),
    status: normalizeText(request.status || 'requested') || 'requested',
    riskClass: normalizeText(request.risk_class || request.riskClass || '') || null,
    objection: normalizeText(request.objection || ''),
    sourceLocator: normalizeText(request.source_locator || request.sourceLocator || '') || null,
    evidenceLocator: normalizeText(request.evidence_locator || request.evidenceLocator || '') || null,
    proposedFix: normalizeText(request.proposed_fix || request.proposedFix || '') || null,
    verification: normalizeText(request.verification || '') || null,
    sourcePatchId: request.source_patch_id || request.sourcePatchId || null,
    workerPatchId: request.worker_patch_id || request.workerPatchId || null,
  }));
  const patches = (patchQueue || []).slice(0, 128).map((patch, index) => ({
    id: normalizedId(patch.patch_id || patch.patchId || patch.id, `${paperTask.paperId}:patch:${index + 1}`),
    status: normalizeText(patch.status || 'queued') || 'queued',
    patchPath: normalizeText(patch.patch_path || patch.patchPath || '') || null,
    patchSha256: normalizeText(patch.patch_sha256 || patch.patchSha256 || '') || null,
    targetPaths: Array.isArray(patch.targetPaths) ? patch.targetPaths : [],
    batchId: normalizeText(patch.batch_id || patch.batchId || '') || null,
  }));
  const openIssues = issues.filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const queue = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionIssueQueue',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: openIssues.length ? 'open_referee_revision_items' : 'referee_revision_queue_clear',
    issueCount: issues.length,
    openIssueCount: openIssues.length,
    patchCount: patches.length,
    issues,
    patchQueue: patches,
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...queue, refereeRevisionIssueQueueHash: hashPaperRecord('RefereeRevisionIssueQueue', queue) };
}

export function buildRefereeRevisionPatchPlan({
  paperTask,
  issueQueue,
  mode = 'dry-run',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) throw new Error('RefereeRevisionPatchPlan requires paperTask and issueQueue');
  const openIssues = (issueQueue.issues || []).filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const planItems = openIssues.slice(0, 64).map((issue, index) => ({
    id: `${issue.id}:plan:${index + 1}`,
    issueId: issue.id,
    action: 'plan_patch_or_claim_downgrade',
    sourceLocator: issue.sourceLocator,
    proposedFix: issue.proposedFix,
    verification: issue.verification,
  }));
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionPatchPlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizeText(mode) || 'dry-run',
    status: planItems.length ? 'dry_run_patch_plan_ready' : 'no_referee_revision_patch_needed',
    issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
    planItemCount: planItems.length,
    planItems,
    rollbackRequiredForExecute: true,
    safety: {
      dryRunOnly: true,
      sourceMutation: false,
      requiresRollbackLedgerForExecute: true,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...plan, refereeRevisionPatchPlanHash: hashPaperRecord('RefereeRevisionPatchPlan', plan) };
}

export function buildRefereeRevisionPatchExecutionPreflight({
  paperTask,
  issueQueue,
  patchPlan,
  sourceWorkspace = null,
  mode = 'dry-run',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereeRevisionPatchExecutionPreflight requires paperTask, issueQueue, and patchPlan');
  }
  const blockers = [];
  const warnings = [];
  const normalizedMode = normalizeText(mode) || 'dry-run';
  const openIssues = (issueQueue.issues || [])
    .filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const candidatePatches = (issueQueue.patchQueue || [])
    .filter((patch) => !['applied', 'rejected', 'superseded'].includes(patch.status));
  const targetPaths = uniqueStrings(
    candidatePatches.flatMap((patch) => patch.targetPaths || []).map((target) => normalizeText(target)).filter(Boolean),
    128,
  );
  if (normalizedMode !== 'dry-run') blockers.push('referee_revision_execute_disabled_in_overlay');
  if (!sourceWorkspace) blockers.push('source_workspace_required_for_patch_preflight');
  if (openIssues.length && !patchPlan.planItemCount) blockers.push('patch_plan_missing_for_open_issues');
  if (candidatePatches.length && !targetPaths.length) warnings.push('patch_queue_target_paths_missing');
  if (openIssues.length && !candidatePatches.length) warnings.push('open_issues_without_patch_queue_entries');
  const preflight = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionPatchExecutionPreflight',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizedMode,
    status: blockers.length
      ? 'blocked_preflight'
      : (openIssues.length ? 'dry_run_patch_execution_preflight_ready' : 'no_referee_revision_execution_needed'),
    issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
    patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
    sourceWorkspace: normalizeText(sourceWorkspace) || null,
    openIssueCount: openIssues.length,
    candidatePatchCount: candidatePatches.length,
    targetPathCount: targetPaths.length,
    targetPaths,
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      dryRunOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      requiresRollbackLedgerForExecute: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...preflight,
    refereeRevisionPatchExecutionPreflightHash: hashPaperRecord('RefereeRevisionPatchExecutionPreflight', preflight),
  };
}

export function buildRefereeRevisionRollbackLedgerDraft({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight,
  mode = 'dry-run',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !patchPlan?.kind || !patchExecutionPreflight?.kind) {
    throw new Error('RefereeRevisionRollbackLedgerDraft requires paperTask, patchPlan, and patchExecutionPreflight');
  }
  const blockers = [];
  const normalizedMode = normalizeText(mode) || 'dry-run';
  if (normalizedMode !== 'dry-run') blockers.push('rollback_ledger_execute_requires_real_preimage_snapshot');
  if (patchExecutionPreflight.status === 'blocked_preflight') blockers.push('patch_execution_preflight_blocked');
  const targetPaths = patchExecutionPreflight.targetPaths || [];
  const entries = targetPaths.map((targetPath, index) => ({
    id: `${paperTask.paperId}:rollback:${index + 1}`,
    targetPath,
    preimageHash: null,
    postimageHash: null,
    snapshotStatus: 'snapshot_required_before_execute',
    restoreAction: 'restore_preimage_before_commit',
  }));
  const draft = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionRollbackLedgerDraft',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizedMode,
    status: blockers.length
      ? 'blocked_rollback_ledger_draft'
      : (entries.length ? 'rollback_ledger_draft_ready' : 'no_rollback_entries_needed'),
    issueQueueHash: issueQueue?.refereeRevisionIssueQueueHash || null,
    patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
    patchExecutionPreflightHash: patchExecutionPreflight.refereeRevisionPatchExecutionPreflightHash,
    entryCount: entries.length,
    entries,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      dryRunOnly: true,
      sourceMutation: false,
      writesRollbackLedger: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...draft,
    refereeRevisionRollbackLedgerDraftHash: hashPaperRecord('RefereeRevisionRollbackLedgerDraft', draft),
  };
}

export function buildRefereeRevisionPreimageSnapshotLedger({
  paperTask,
  patchExecutionPreflight,
  targetRecords = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !patchExecutionPreflight?.kind) {
    throw new Error('RefereeRevisionPreimageSnapshotLedger requires paperTask and patchExecutionPreflight');
  }
  const targetRecordByPath = new Map((targetRecords || [])
    .map((record) => [normalizeText(record.path), record])
    .filter(([key]) => key));
  const entries = (patchExecutionPreflight.targetPaths || []).map((targetPath, index) => {
    const record = targetRecordByPath.get(normalizeText(targetPath));
    return {
      id: `${paperTask.paperId}:preimage:${index + 1}`,
      targetPath: normalizeText(targetPath),
      exists: Boolean(record),
      preimageHash: record?.hash || null,
      sizeBytes: Number.isFinite(Number(record?.sizeBytes)) ? Number(record.sizeBytes) : null,
      snapshotStatus: record ? 'preimage_hash_recorded' : 'target_missing_before_execute',
    };
  });
  const missing = entries.filter((entry) => !entry.exists);
  const ledger = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionPreimageSnapshotLedger',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: missing.length ? 'preimage_snapshot_incomplete' : (entries.length ? 'preimage_snapshot_ready' : 'no_preimage_targets'),
    patchExecutionPreflightHash: patchExecutionPreflight.refereeRevisionPatchExecutionPreflightHash,
    targetCount: entries.length,
    missingTargetCount: missing.length,
    entries,
    blockers: uniqueStrings(missing.map((entry) => `target_missing:${entry.targetPath}`), 32),
    safety: {
      readsOnly: true,
      writesSource: false,
      appliesPatch: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...ledger,
    refereeRevisionPreimageSnapshotLedgerHash: hashPaperRecord('RefereeRevisionPreimageSnapshotLedger', ledger),
  };
}

export function buildRefereeRevisionExecutePlan({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight,
  preimageSnapshotLedger,
  mode = 'execute-plan',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !patchPlan?.kind || !patchExecutionPreflight?.kind || !preimageSnapshotLedger?.kind) {
    throw new Error('RefereeRevisionExecutePlan requires paperTask, patchPlan, preflight, and preimage snapshot ledger');
  }
  const blockers = [];
  if (patchExecutionPreflight.status !== 'dry_run_patch_execution_preflight_ready') blockers.push('patch_execution_preflight_not_ready');
  if (preimageSnapshotLedger.status !== 'preimage_snapshot_ready') blockers.push('preimage_snapshot_not_ready');
  if (!patchPlan.planItemCount) blockers.push('patch_plan_empty');
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionExecutePlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizeText(mode) || 'execute-plan',
    status: blockers.length ? 'execute_plan_blocked' : 'execute_plan_ready_requires_explicit_apply_mode',
    issueQueueHash: issueQueue?.refereeRevisionIssueQueueHash || null,
    patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
    patchExecutionPreflightHash: patchExecutionPreflight.refereeRevisionPatchExecutionPreflightHash,
    preimageSnapshotLedgerHash: preimageSnapshotLedger.refereeRevisionPreimageSnapshotLedgerHash,
    requiredExecutionOrder: [
      'write_preimage_snapshot_ledger',
      'apply_single_paper_patch',
      'run_latex_build',
      'run_package_adapter',
      'run_research_verify_adapter',
      'write_postimage_snapshot',
      'reconcile_rollback_ledger',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      planOnly: true,
      appliesPatch: false,
      writesSource: false,
      externalActionPerformed: false,
      requiresExplicitApplyMode: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...plan, refereeRevisionExecutePlanHash: hashPaperRecord('RefereeRevisionExecutePlan', plan) };
}

export function buildRefereeRevisionApplyModeContract({
  paperTask,
  executePlan,
  approved = false,
  approver = '',
  approvalActor = 'agent',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !executePlan?.kind) {
    throw new Error('RefereeRevisionApplyModeContract requires paperTask and executePlan');
  }
  const blockers = [];
  const normalizedActor = normalizeText(approvalActor) || 'agent';
  const normalizedApprover = normalizeText(approver);
  if (!approved) blockers.push('agent_referee_apply_approval_required');
  if (approved && normalizedActor !== 'agent') blockers.push('agent_referee_apply_approval_required');
  if (approved && !normalizedApprover) blockers.push('agent_id_required');
  if (executePlan.status !== 'execute_plan_ready_requires_explicit_apply_mode') blockers.push('execute_plan_not_ready');
  const contract = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionApplyModeContract',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'apply_mode_blocked' : 'apply_mode_ready',
    approved: Boolean(approved) && blockers.length === 0,
    approvalActor: normalizedActor,
    approver: normalizedApprover || null,
    executePlanHash: executePlan.refereeRevisionExecutePlanHash,
    requiredPreconditions: [
      'agent_referee_apply_approval',
      'clean_or_isolated_worktree',
      'preimage_snapshot_ledger_ready',
      'single_paper_patch_scope',
      'rollback_restore_command_available',
    ],
    requiredPostconditions: [
      'postimage_snapshot_written',
      'latex_build_rechecked',
      'package_record_rewritten',
      'research_verify_rechecked',
      'rollback_ledger_reconciled',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      contractOnly: true,
      appliesPatch: false,
      writesSource: false,
      externalActionPerformed: false,
      requiresSeparateApplyInvocation: true,
      agentApprovalOnly: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...contract,
    refereeRevisionApplyModeContractHash: hashPaperRecord('RefereeRevisionApplyModeContract', contract),
  };
}

export function buildRefereeRevisionDryRunReceipt({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight = null,
  rollbackLedgerDraft = null,
  preimageSnapshotLedger = null,
  executePlan = null,
  applyModeContract = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !patchPlan?.kind) throw new Error('RefereeRevisionDryRunReceipt requires paperTask and patchPlan');
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionDryRunReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: 'dry_run_recorded',
    issueQueueHash: issueQueue?.refereeRevisionIssueQueueHash || null,
    patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
    patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
    rollbackLedgerDraftHash: rollbackLedgerDraft?.refereeRevisionRollbackLedgerDraftHash || null,
    preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
    executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
    applyModeContractHash: applyModeContract?.refereeRevisionApplyModeContractHash || null,
    sourceMutationPerformed: false,
    rollbackLedgerWritten: false,
    executeBlockedUntilExplicitMode: true,
    createdAt: createdAt || nowIso(),
  };
  return { ...receipt, refereeRevisionDryRunReceiptHash: hashPaperRecord('RefereeRevisionDryRunReceipt', receipt) };
}

export function buildRefereeRevisionExecuteDesignPacket({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight = null,
  preimageSnapshotLedger = null,
  executePlan = null,
  applyModeContract = null,
  dryRunReceipt = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereeRevisionExecuteDesignPacket requires paperTask, issueQueue, and patchPlan');
  }
  const blockers = [];
  if (issueQueue.openIssueCount && patchExecutionPreflight?.status !== 'dry_run_patch_execution_preflight_ready') {
    blockers.push('patch_execution_preflight_not_ready');
  }
  if (issueQueue.openIssueCount && preimageSnapshotLedger?.status !== 'preimage_snapshot_ready') {
    blockers.push('preimage_snapshot_not_ready');
  }
  if (issueQueue.openIssueCount && executePlan?.status !== 'execute_plan_ready_requires_explicit_apply_mode') {
    blockers.push('execute_plan_not_ready');
  }
  const applyReady = applyModeContract?.status === 'apply_mode_ready';
  const applyBlocked = !applyReady && (
    (applyModeContract?.blockers || []).includes('agent_referee_apply_approval_required')
  );
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeRevisionExecuteDesignPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !issueQueue.openIssueCount
      ? 'no_referee_execute_needed'
      : (blockers.length
        ? 'referee_execute_design_blocked'
        : (applyReady ? 'referee_execute_design_ready_for_apply_execution' : 'referee_execute_design_ready_apply_blocked')),
    issueCount: issueQueue.issueCount,
    openIssueCount: issueQueue.openIssueCount,
    targetPathCount: patchExecutionPreflight?.targetPathCount || 0,
    chain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
      patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
      preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
      executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
      applyModeContractHash: applyModeContract?.refereeRevisionApplyModeContractHash || null,
      dryRunReceiptHash: dryRunReceipt?.refereeRevisionDryRunReceiptHash || null,
    },
    requiredAuthorization: [
      'agent_referee_apply_approval',
      'clean_or_isolated_worktree',
      'single_paper_patch_scope',
      'preimage_snapshot_ledger_ready',
      'rollback_restore_command_available',
    ],
    executionOrder: executePlan?.requiredExecutionOrder || [
      'write_preimage_snapshot_ledger',
      'apply_single_paper_patch',
      'run_latex_build',
      'run_package_adapter',
      'run_research_verify_adapter',
      'write_postimage_snapshot',
      'reconcile_rollback_ledger',
    ],
    reentryGates: [
      'latex_build_recheck',
      'package_record_rewrite',
      'research_verify_recheck',
      'local_dry_run_recheck',
      'referee_issue_queue_reconcile',
    ],
    blockedActionsUntilApplyMode: [
      'apply_patch_to_source',
      'merge_or_commit_source_changes',
      'mark_referee_issues_resolved',
      'advance_submission_readiness_from_unverified_patch',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(applyBlocked ? ['apply_mode_waiting_for_agent_approval'] : [], 32),
    safety: {
      designOnly: true,
      appliesPatch: false,
      writesSource: false,
      externalActionPerformed: false,
      requiresSeparateApplyInvocation: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    refereeRevisionExecuteDesignPacketHash: hashPaperRecord('RefereeRevisionExecuteDesignPacket', packet),
  };
}

export function buildRefereeApplyApprovalPacket({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight = null,
  rollbackLedgerDraft = null,
  preimageSnapshotLedger = null,
  executePlan = null,
  applyModeContract = null,
  executeDesignPacket = null,
  approved = false,
  approver = 'openclaw-agent',
  approvalActor = 'agent',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereeApplyApprovalPacket requires paperTask, issueQueue, and patchPlan');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const approvalNeeded = openIssueCount > 0;
  const normalizedActor = normalizeText(approvalActor) || 'agent';
  const normalizedApprover = normalizeText(approver);
  const blockers = [];
  if (approvalNeeded && !approved) blockers.push('agent_referee_apply_approval_required');
  if (approvalNeeded && approved && normalizedActor !== 'agent') blockers.push('agent_referee_apply_approval_required');
  if (approvalNeeded && approved && !normalizedApprover) blockers.push('agent_id_required');
  if (approvalNeeded && ![
    'referee_execute_design_ready_apply_blocked',
    'referee_execute_design_ready_for_apply_execution',
  ].includes(executeDesignPacket?.status)) {
    blockers.push('execute_design_packet_not_ready');
  }
  if (approvalNeeded && executePlan?.status !== 'execute_plan_ready_requires_explicit_apply_mode') {
    blockers.push('execute_plan_not_ready');
  }
  if (approvalNeeded && rollbackLedgerDraft?.status !== 'rollback_ledger_draft_ready') {
    blockers.push('rollback_ledger_draft_not_ready');
  }
  if (approvalNeeded && preimageSnapshotLedger?.status !== 'preimage_snapshot_ready') {
    blockers.push('preimage_snapshot_not_ready');
  }
  if (approvalNeeded && approved && applyModeContract?.status !== 'apply_mode_ready') {
    blockers.push('apply_mode_contract_not_ready');
  }
  const preimageEntries = preimageSnapshotLedger?.entries || [];
  const targetPaths = preimageEntries.length
    ? preimageEntries.map((entry) => entry.targetPath)
    : (patchExecutionPreflight?.targetPaths || []);
  const targetPathAcceptance = targetPaths.map((targetPath, index) => {
    const preimage = preimageEntries.find((entry) => entry.targetPath === targetPath);
    return {
      id: `${paperTask.paperId}:referee-apply-target:${index + 1}`,
      targetPath: normalizeText(targetPath),
      preimageHash: preimage?.preimageHash || null,
      preimageSnapshotStatus: preimage?.snapshotStatus || 'preimage_snapshot_required',
      acceptedByAgent: approvalNeeded && Boolean(approved) && blockers.length === 0,
      acceptedByOperator: false,
    };
  });
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeApplyApprovalPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !approvalNeeded
      ? 'no_referee_apply_approval_needed'
      : (blockers.length ? 'referee_apply_approval_blocked' : 'referee_apply_approval_ready_for_patch_execution'),
    approved: approvalNeeded && Boolean(approved) && blockers.length === 0,
    approvalActor: normalizedActor,
    approver: approvalNeeded && approved ? normalizedApprover || null : null,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    targetPathCount: targetPathAcceptance.length,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
      patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
      rollbackLedgerDraftHash: rollbackLedgerDraft?.refereeRevisionRollbackLedgerDraftHash || null,
      preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
      executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
      applyModeContractHash: applyModeContract?.refereeRevisionApplyModeContractHash || null,
      executeDesignPacketHash: executeDesignPacket?.refereeRevisionExecuteDesignPacketHash || null,
    },
    requiredAgentApprovalInputs: [
      'approval_decision',
      'agent_id',
      'decision_timestamp',
      'accepted_issue_queue_hash',
      'accepted_patch_plan_hash',
      'accepted_patch_execution_preflight_hash',
      'accepted_rollback_ledger_draft_hash',
      'accepted_preimage_snapshot_ledger_hash',
      'accepted_execute_plan_hash',
      'accepted_execute_design_packet_hash',
      'accepted_target_paths',
      'accepted_preimage_hashes',
      'worktree_scope_confirmation',
      'rollback_restore_confirmation',
    ],
    requiredOperatorInputs: [],
    approvalIntakeTemplate: {
      approvalDecision: approvalNeeded && approved && blockers.length === 0 ? 'approved_by_agent' : null,
      agentId: approvalNeeded && approved ? normalizedApprover || null : null,
      operatorId: null,
      decisionTimestamp: approvalNeeded && approved && blockers.length === 0 ? (createdAt || nowIso()) : null,
      acceptedHashes: {
        issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
        patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
        patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
        rollbackLedgerDraftHash: rollbackLedgerDraft?.refereeRevisionRollbackLedgerDraftHash || null,
        preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
        executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
        executeDesignPacketHash: executeDesignPacket?.refereeRevisionExecuteDesignPacketHash || null,
      },
      acceptedTargetPaths: approvalNeeded && approved && blockers.length === 0 ? targetPaths : [],
      acceptedPreimageHashes: approvalNeeded && approved && blockers.length === 0
        ? preimageEntries.map((entry) => entry.preimageHash).filter(Boolean)
        : [],
      rollbackRestoreConfirmed: approvalNeeded && approved && blockers.length === 0,
      worktreeScopeConfirmed: approvalNeeded && approved && blockers.length === 0,
      cleanOrIsolatedWorktreeConfirmed: false,
    },
    targetPathAcceptance,
    rollbackAcceptance: (rollbackLedgerDraft?.entries || []).map((entry) => ({
      targetPath: entry.targetPath,
      snapshotStatus: entry.snapshotStatus,
      restoreAction: entry.restoreAction,
      acceptedByAgent: approvalNeeded && Boolean(approved) && blockers.length === 0,
      acceptedByOperator: false,
    })),
    nextAllowedStepWhenApproved: 'referee_patch_apply_execution',
    blockedActionsUntilApproved: [
      'apply_patch_to_source',
      'write_postimage_snapshot',
      'mark_referee_issues_resolved',
      'rebuild_repaired_package',
      'advance_submission_readiness_from_repair',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      approvalIntakeOnly: true,
      agentApprovalOnly: true,
      appliesPatch: false,
      writesSource: false,
      sourceMutation: false,
      externalActionPerformed: false,
      grantsSourceMutationInsideOverlay: false,
      requiresSeparateApplyExecutor: true,
      requiresPostApplyReceipts: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    refereeApplyApprovalPacketHash: hashPaperRecord('RefereeApplyApprovalPacket', packet),
  };
}

export function buildRefereePatchApplyExecution({
  paperTask,
  issueQueue,
  patchPlan,
  patchExecutionPreflight = null,
  preimageSnapshotLedger = null,
  executePlan = null,
  applyModeContract = null,
  executeDesignPacket = null,
  applyApprovalPacket = null,
  execute = false,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereePatchApplyExecution requires paperTask, issueQueue, and patchPlan');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const approvalReady = applyApprovalPacket?.status === 'referee_apply_approval_ready_for_patch_execution';
  const blockers = [];
  if (openIssueCount && executePlan?.status !== 'execute_plan_ready_requires_explicit_apply_mode') {
    blockers.push('execute_plan_not_ready');
  }
  if (openIssueCount && preimageSnapshotLedger?.status !== 'preimage_snapshot_ready') {
    blockers.push('preimage_snapshot_not_ready');
  }
  if (openIssueCount && ![
    'referee_execute_design_ready_apply_blocked',
    'referee_execute_design_ready_for_apply_execution',
  ].includes(executeDesignPacket?.status)) {
    blockers.push('execute_design_packet_not_ready');
  }
  if (openIssueCount && !approvalReady) blockers.push('referee_apply_approval_not_ready');
  if (openIssueCount && approvalReady && applyModeContract?.status !== 'apply_mode_ready') {
    blockers.push('apply_mode_contract_not_ready');
  }
  const candidatePatches = (issueQueue.patchQueue || [])
    .filter((patch) => !['applied', 'rejected', 'superseded'].includes(patch.status));
  const targetPreimages = (preimageSnapshotLedger?.entries || []).map((entry) => ({
    targetPath: entry.targetPath,
    preimageHash: entry.preimageHash,
    snapshotStatus: entry.snapshotStatus,
  }));
  const execution = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereePatchApplyExecution',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssueCount
      ? 'no_referee_patch_apply_needed'
      : (blockers.length ? 'referee_patch_apply_execution_blocked' : 'referee_patch_apply_ready_for_separate_executor'),
    executionPerformed: false,
    sourceMutationPerformed: false,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    candidatePatchCount: candidatePatches.length,
    targetPathCount: patchExecutionPreflight?.targetPathCount || targetPreimages.length,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
      patchExecutionPreflightHash: patchExecutionPreflight?.refereeRevisionPatchExecutionPreflightHash || null,
      preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
      executePlanHash: executePlan?.refereeRevisionExecutePlanHash || null,
      applyModeContractHash: applyModeContract?.refereeRevisionApplyModeContractHash || null,
      executeDesignPacketHash: executeDesignPacket?.refereeRevisionExecuteDesignPacketHash || null,
      applyApprovalPacketHash: applyApprovalPacket?.refereeApplyApprovalPacketHash || null,
    },
    plannedPatchInputs: candidatePatches.map((patch) => ({
      patchId: patch.id,
      patchPath: patch.patchPath,
      patchSha256: patch.patchSha256,
      targetPaths: patch.targetPaths || [],
      status: patch.status,
    })),
    targetPreimages,
    requiredExecutionOrder: [
      'validate_referee_apply_approval_packet',
      'verify_hash_chain_matches_approval_packet',
      'verify_target_preimage_hashes',
      'apply_patch_queue_entries_to_source',
      'write_postimage_snapshot_ledger',
      'run_latex_build_recheck',
      'run_package_adapter_rewrite',
      'run_research_verify_recheck',
      'write_applied_patch_receipt',
      'reconcile_referee_issue_resolution',
    ],
    blockedActionsUntilAppliedPatchReceipt: [
      'mark_referee_issues_resolved',
      'replace_submit_ready_package',
      'advance_reviewed_submit_readiness',
      'archive_repaired_manuscript_as_final',
    ],
    nextRequiredStep: 'referee_patch_apply_invocation',
    executeInvocationRequested: Boolean(execute),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      executionSurfaceOnly: true,
      appliesPatch: false,
      writesSource: false,
      sourceMutation: false,
      externalActionPerformed: false,
      requiresApprovedRefereeApplyApprovalPacket: true,
      requiresSeparateSourceMutationExecutor: true,
      requiresAppliedPatchReceipt: true,
      requiresPostRepairGateRecheck: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...execution,
    refereePatchApplyExecutionHash: hashPaperRecord('RefereePatchApplyExecution', execution),
  };
}

export function buildRefereePatchApplyInvocation({
  paperTask,
  issueQueue,
  patchApplyExecution = null,
  applyApprovalPacket = null,
  execute = false,
  executorId = 'openclaw-agent-local-patch-apply',
  validationRecords = [],
  targetPreimageChecks = [],
  appliedPatchHashes = [],
  postimageRecords = [],
  sourceDiffHash = null,
  applied = false,
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('RefereePatchApplyInvocation requires paperTask and issueQueue');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const normalizedExecutorId = normalizeText(executorId) || null;
  const executionReady = patchApplyExecution?.status === 'referee_patch_apply_ready_for_separate_executor';
  const normalizedValidationRecords = (validationRecords || []).slice(0, 256).map((record, index) => ({
    id: normalizedId(record.id || record.patchId, `${paperTask.paperId}:patch-validation:${index + 1}`),
    patchId: normalizeText(record.patchId || '') || null,
    patchPath: normalizeText(record.patchPath || '') || null,
    patchHashExpected: normalizeText(record.patchHashExpected || '') || null,
    patchHashActual: normalizeText(record.patchHashActual || '') || null,
    targetPaths: uniqueStrings(record.targetPaths || [], 64),
    cleanApplyCheck: normalizeText(record.cleanApplyCheck || '') || null,
    blockers: uniqueStrings(record.blockers || [], 32),
    stderr: uniqueStrings(record.stderr || [], 16),
  }));
  const normalizedPreimageChecks = (targetPreimageChecks || []).slice(0, 256).map((record, index) => ({
    id: normalizedId(record.id || record.targetPath, `${paperTask.paperId}:preimage-check:${index + 1}`),
    targetPath: normalizeText(record.targetPath || '') || null,
    expectedPreimageHash: normalizeText(record.expectedPreimageHash || '') || null,
    actualPreimageHash: normalizeText(record.actualPreimageHash || '') || null,
    status: normalizeText(record.status || '') || null,
    blockers: uniqueStrings(record.blockers || [], 16),
  }));
  const normalizedPostimages = (postimageRecords || []).slice(0, 256).map((record, index) => ({
    id: normalizedId(record.id || record.path || record.targetPath, `${paperTask.paperId}:postimage:${index + 1}`),
    targetPath: normalizeText(record.targetPath || record.path || '') || null,
    postimageHash: normalizeText(record.postimageHash || record.hash || '') || null,
    sizeBytes: Number.isFinite(Number(record.sizeBytes)) ? Number(record.sizeBytes) : null,
  })).filter((record) => record.targetPath);
  const invocationBlockers = [...(blockers || [])];
  for (const record of normalizedValidationRecords) invocationBlockers.push(...(record.blockers || []));
  for (const record of normalizedPreimageChecks) invocationBlockers.push(...(record.blockers || []));
  if (openIssueCount && !executionReady) invocationBlockers.push('referee_patch_apply_execution_not_ready');
  if (openIssueCount && executionReady && !execute) invocationBlockers.push('explicit_referee_patch_apply_execute_invocation_required');
  if (openIssueCount && execute && !normalizedExecutorId) invocationBlockers.push('executor_id_required');
  if (openIssueCount && execute && !normalizedValidationRecords.length) invocationBlockers.push('patch_validation_records_required');
  if (openIssueCount && execute && Boolean(applied) && !normalizedPostimages.length) {
    invocationBlockers.push('postimage_snapshot_required');
  }
  if (openIssueCount && execute && !Boolean(applied) && !invocationBlockers.length) {
    invocationBlockers.push('patch_apply_executor_did_not_apply');
  }
  const appliedCleanly = openIssueCount > 0 && Boolean(execute) && Boolean(applied) && invocationBlockers.length === 0;
  const invocation = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereePatchApplyInvocation',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssueCount
      ? 'no_referee_patch_apply_invocation_needed'
      : (invocationBlockers.length ? 'referee_patch_apply_invocation_blocked' : 'referee_patch_apply_invocation_applied'),
    executeRequested: Boolean(execute),
    executorId: normalizedExecutorId,
    approvedByAgent: applyApprovalPacket?.approvalActor === 'agent' && applyApprovalPacket?.approved === true,
    appliedPatchPerformed: appliedCleanly,
    sourceMutationPerformed: appliedCleanly,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    plannedPatchInputCount: patchApplyExecution?.plannedPatchInputs?.length || 0,
    validationRecordCount: normalizedValidationRecords.length,
    targetPreimageCheckCount: normalizedPreimageChecks.length,
    postimageCount: normalizedPostimages.length,
    appliedPatchHashes: uniqueStrings(appliedPatchHashes || [], 256),
    sourceDiffHash: normalizeText(sourceDiffHash || '') || null,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchApplyExecutionHash: patchApplyExecution?.refereePatchApplyExecutionHash || null,
      applyApprovalPacketHash: applyApprovalPacket?.refereeApplyApprovalPacketHash || null,
    },
    validationRecords: normalizedValidationRecords,
    targetPreimageChecks: normalizedPreimageChecks,
    postimageRecords: normalizedPostimages,
    blockers: uniqueStrings(invocationBlockers, 64),
    warnings: uniqueStrings(warnings || [], 32),
    safety: {
      invocationReceiptOnlyWhenBlocked: !appliedCleanly,
      appliesPatch: appliedCleanly,
      writesSource: appliedCleanly,
      sourceMutation: appliedCleanly,
      externalActionPerformed: false,
      requiresAppliedPatchReceipt: true,
      requiresPostRepairGateRecheck: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...invocation,
    refereePatchApplyInvocationHash: hashPaperRecord('RefereePatchApplyInvocation', invocation),
  };
}

export function buildRefereeAppliedPatchReceipt({
  paperTask,
  issueQueue,
  patchPlan,
  patchApplyExecution = null,
  patchApplyInvocation = null,
  applyApprovalPacket = null,
  preimageSnapshotLedger = null,
  applied = false,
  executorId = '',
  postimageRecords = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind || !patchPlan?.kind) {
    throw new Error('RefereeAppliedPatchReceipt requires paperTask, issueQueue, and patchPlan');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const executionReady = patchApplyExecution?.status === 'referee_patch_apply_ready_for_separate_executor';
  const invocationApplied = patchApplyInvocation?.status === 'referee_patch_apply_invocation_applied';
  const blockers = [];
  if (openIssueCount && !executionReady) blockers.push('referee_patch_apply_execution_not_ready');
  if (openIssueCount && executionReady && !invocationApplied) blockers.push('referee_patch_apply_invocation_not_applied');
  if (openIssueCount && invocationApplied && !applied) blockers.push('applied_patch_receipt_missing');
  if (openIssueCount && applied && !normalizeText(executorId)) blockers.push('executor_id_required');
  if (openIssueCount && applied && !postimageRecords.length) blockers.push('postimage_snapshot_required');
  const normalizedPostimages = (postimageRecords || []).slice(0, 128).map((record, index) => ({
    id: normalizedId(record.id || record.path, `${paperTask.paperId}:postimage:${index + 1}`),
    targetPath: normalizeText(record.targetPath || record.path || ''),
    postimageHash: normalizeText(record.postimageHash || record.hash || '') || null,
    sizeBytes: Number.isFinite(Number(record.sizeBytes)) ? Number(record.sizeBytes) : null,
  })).filter((record) => record.targetPath);
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeAppliedPatchReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssueCount
      ? 'no_referee_applied_patch_receipt_needed'
      : (blockers.length ? 'applied_patch_receipt_blocked' : 'applied_patch_receipt_recorded'),
    executorId: normalizeText(executorId) || null,
    appliedPatchPerformed: openIssueCount > 0 && Boolean(applied) && blockers.length === 0,
    sourceMutationPerformed: openIssueCount > 0 && Boolean(applied) && blockers.length === 0,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    plannedPatchInputCount: patchApplyExecution?.plannedPatchInputs?.length || 0,
    postimageCount: normalizedPostimages.length,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchPlanHash: patchPlan.refereeRevisionPatchPlanHash,
      applyApprovalPacketHash: applyApprovalPacket?.refereeApplyApprovalPacketHash || null,
      patchApplyExecutionHash: patchApplyExecution?.refereePatchApplyExecutionHash || null,
      patchApplyInvocationHash: patchApplyInvocation?.refereePatchApplyInvocationHash || null,
      preimageSnapshotLedgerHash: preimageSnapshotLedger?.refereeRevisionPreimageSnapshotLedgerHash || null,
    },
    expectedReceiptFields: [
      'patch_apply_invocation_hash',
      'executor_id',
      'applied_patch_input_hashes',
      'accepted_preimage_hashes',
      'postimage_hashes',
      'source_mutation_diff_hash',
      'latex_build_recheck_result',
      'package_rewrite_result',
      'research_verify_recheck_result',
      'rollback_ledger_reconciliation_result',
    ],
    plannedPatchInputs: patchApplyExecution?.plannedPatchInputs || [],
    acceptedPreimages: patchApplyInvocation?.targetPreimageChecks || patchApplyExecution?.targetPreimages || (preimageSnapshotLedger?.entries || []),
    postimageRecords: normalizedPostimages,
    blockedActionsUntilReceiptRecorded: [
      'post_repair_build_package',
      'mark_referee_issues_resolved',
      'write_referee_issue_resolution_proof',
      'advance_reviewed_submit_readiness',
      'archive_repaired_manuscript_as_final',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      receiptOnly: true,
      appliesPatch: false,
      writesSource: false,
      externalActionPerformed: false,
      requiresActualSourceMutationExecutorReceipt: true,
      requiresPostRepairGateRecheck: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...receipt,
    refereeAppliedPatchReceiptHash: hashPaperRecord('RefereeAppliedPatchReceipt', receipt),
  };
}

export function buildPostRepairBuildPackage({
  paperTask,
  issueQueue,
  patchApplyExecution = null,
  appliedPatchReceipt = null,
  buildRecheck = null,
  packageRecheck = null,
  researchRecheck = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('PostRepairBuildPackage requires paperTask and issueQueue');
  }
  const openIssueCount = Number(issueQueue.openIssueCount || 0);
  const receiptRecorded = appliedPatchReceipt?.status === 'applied_patch_receipt_recorded';
  const blockers = [];
  if (openIssueCount && !receiptRecorded) blockers.push('applied_patch_receipt_not_recorded');
  if (openIssueCount && receiptRecorded && buildRecheck?.status !== 'build_recheck_passed') {
    blockers.push('post_repair_build_recheck_missing');
  }
  if (openIssueCount && receiptRecorded && packageRecheck?.status !== 'package_rewrite_ready') {
    blockers.push('post_repair_package_rewrite_missing');
  }
  if (openIssueCount && receiptRecorded && researchRecheck?.status !== 'research_recheck_passed') {
    blockers.push('post_repair_research_recheck_missing');
  }
  const gate = {
    version: PAPER_CORE_VERSION,
    kind: 'PostRepairBuildPackage',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssueCount
      ? 'no_post_repair_build_package_needed'
      : (blockers.length ? 'post_repair_build_package_blocked' : 'post_repair_build_package_ready'),
    repairedPackageWritten: false,
    issueCount: issueQueue.issueCount,
    openIssueCount,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      patchApplyExecutionHash: patchApplyExecution?.refereePatchApplyExecutionHash || null,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
      buildRecheckHash: buildRecheck?.hash || buildRecheck?.buildRecheckHash || null,
      packageRecheckHash: packageRecheck?.hash || packageRecheck?.packageRecheckHash || null,
      researchRecheckHash: researchRecheck?.hash || researchRecheck?.researchRecheckHash || null,
    },
    requiredGateRechecks: [
      'applied_patch_receipt_recorded',
      'postimage_snapshot_present',
      'latex_build_recheck_passed',
      'package_record_rewritten',
      'sha256sums_rewritten',
      'research_verify_rechecked',
      'rollback_ledger_reconciled',
    ],
    expectedArtifacts: [
      'repaired_pdf',
      'repaired_source_package',
      'post_repair_package_record',
      'post_repair_sha256sums',
      'post_repair_research_verify_receipt',
    ],
    blockedActionsUntilPostRepairPackage: [
      'mark_referee_issues_resolved',
      'write_referee_issue_resolution_proof',
      'advance_reviewed_submit_readiness',
      'archive_repaired_manuscript_as_final',
      'replace_current_submit_ready_package',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      gateOnly: true,
      writesSource: false,
      writesPackage: false,
      sourceMutation: false,
      externalActionPerformed: false,
      requiresAppliedPatchReceipt: true,
      requiresPostRepairRechecks: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...gate,
    postRepairBuildPackageHash: hashPaperRecord('PostRepairBuildPackage', gate),
  };
}

export function buildRefereeIssueResolutionProof({
  paperTask,
  issueQueue,
  appliedPatchReceipt = null,
  postRepairBuildPackage = null,
  resolutionEvidence = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('RefereeIssueResolutionProof requires paperTask and issueQueue');
  }
  const openIssues = (issueQueue.issues || [])
    .filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const postRepairReady = postRepairBuildPackage?.status === 'post_repair_build_package_ready';
  const normalizedEvidence = (resolutionEvidence || []).slice(0, 128).map((item, index) => ({
    id: normalizedId(item.id || item.ref, `${paperTask.paperId}:resolution-evidence:${index + 1}`),
    issueId: normalizeText(item.issueId || item.issue_id || '') || null,
    kind: normalizeText(item.kind || 'post_repair_evidence') || 'post_repair_evidence',
    ref: normalizeText(item.ref || item.path || item.url || '') || null,
    hash: normalizeText(item.hash || '') || null,
    patchId: normalizeText(item.patchId || item.patch_id || '') || null,
    patchPath: normalizeText(item.patchPath || item.patch_path || '') || null,
    patchHash: normalizeText(item.patchHash || item.patch_sha256 || '') || null,
    repairedArtifactRefs: (item.repairedArtifactRefs || item.repaired_artifact_refs || []).slice(0, 16).map((artifact, artifactIndex) => ({
      id: normalizedId(artifact.id || artifact.ref || artifact.path, `${paperTask.paperId}:repaired-artifact:${index + 1}:${artifactIndex + 1}`),
      role: normalizeText(artifact.role || artifact.kind || 'repaired_artifact') || 'repaired_artifact',
      ref: normalizeText(artifact.ref || artifact.path || '') || null,
      hash: normalizeText(artifact.hash || '') || null,
    })).filter((artifact) => artifact.ref || artifact.hash),
    buildRecheckHash: normalizeText(item.buildRecheckHash || item.build_recheck_hash || '') || null,
    packageRecheckHash: normalizeText(item.packageRecheckHash || item.package_recheck_hash || '') || null,
    researchRecheckHash: normalizeText(item.researchRecheckHash || item.research_recheck_hash || '') || null,
    agentAcceptance: normalizeText(item.agentAcceptance || item.agent_acceptance || '') || null,
  }));
  const blockers = [];
  if (openIssues.length && !postRepairReady) blockers.push('post_repair_build_package_not_ready');
  if (openIssues.length && postRepairReady && appliedPatchReceipt?.status !== 'applied_patch_receipt_recorded') {
    blockers.push('applied_patch_receipt_not_recorded');
  }
  if (openIssues.length && postRepairReady && !normalizedEvidence.length) {
    blockers.push('issue_resolution_evidence_missing');
  }
  const proof = {
    version: PAPER_CORE_VERSION,
    kind: 'RefereeIssueResolutionProof',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssues.length
      ? 'no_referee_issue_resolution_needed'
      : (blockers.length ? 'referee_issue_resolution_proof_blocked' : 'referee_issue_resolution_proof_ready'),
    issueCount: issueQueue.issueCount,
    openIssueCount: openIssues.length,
    resolutionEvidenceCount: normalizedEvidence.length,
    resolvedIssueIds: blockers.length ? [] : openIssues.map((issue) => issue.id),
    candidateIssueIds: openIssues.map((issue) => issue.id),
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
      postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
    },
    requiredProofFields: [
      'post_repair_build_package_hash',
      'applied_patch_receipt_hash',
      'issue_id_to_patch_input_mapping',
      'issue_id_to_repaired_artifact_mapping',
      'build_recheck_receipt_hash',
      'research_recheck_receipt_hash',
      'agent_or_reviewer_acceptance',
    ],
    resolutionEvidence: normalizedEvidence,
    blockedActionsUntilResolutionProof: [
      'mark_referee_issues_resolved',
      'close_patch_queue_entries',
      'advance_reviewed_submit_readiness',
      'archive_repaired_manuscript_as_final',
      'publish_repaired_package_as_current',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      proofOnly: true,
      marksIssuesResolved: false,
      writesSqlite: false,
      writesSource: false,
      writesPackage: false,
      sourceMutation: false,
      externalActionPerformed: false,
      requiresPostRepairPackage: true,
      requiresIssueResolutionEvidence: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...proof,
    refereeIssueResolutionProofHash: hashPaperRecord('RefereeIssueResolutionProof', proof),
  };
}

export function buildRepairReconciliation({
  paperTask,
  issueQueue,
  appliedPatchReceipt = null,
  postRepairBuildPackage = null,
  issueResolutionProof = null,
  repairStateMutationReceipt = null,
  rollbackReconciliation = null,
  issueQueueUpdateReceipt = null,
  patchQueueUpdateReceipt = null,
  submissionReadinessReentryGate = null,
  repairAuditArchiveRecord = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('RepairReconciliation requires paperTask and issueQueue');
  }
  const openIssues = (issueQueue.issues || [])
    .filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const proofReady = issueResolutionProof?.status === 'referee_issue_resolution_proof_ready';
  const blockers = [];
  if (openIssues.length && !proofReady) blockers.push('referee_issue_resolution_proof_not_ready');
  if (openIssues.length && proofReady && postRepairBuildPackage?.status !== 'post_repair_build_package_ready') {
    blockers.push('post_repair_build_package_not_ready');
  }
  if (openIssues.length && proofReady && appliedPatchReceipt?.status !== 'applied_patch_receipt_recorded') {
    blockers.push('applied_patch_receipt_not_recorded');
  }
  if (openIssues.length && proofReady && rollbackReconciliation?.status !== 'rollback_ledger_reconciled') {
    blockers.push('rollback_ledger_reconciliation_missing');
  }
  if (openIssues.length && proofReady && issueQueueUpdateReceipt?.status !== 'issue_queue_update_receipt_ready') {
    blockers.push('issue_queue_update_receipt_missing');
  }
  if (openIssues.length && proofReady && patchQueueUpdateReceipt?.status !== 'patch_queue_update_receipt_ready') {
    blockers.push('patch_queue_update_receipt_missing');
  }
  if (openIssues.length && proofReady && submissionReadinessReentryGate?.status !== 'submission_readiness_reentry_ready') {
    blockers.push('submission_readiness_reentry_gate_missing');
  }
  if (openIssues.length && proofReady && repairAuditArchiveRecord?.status !== 'repair_audit_archive_record_ready') {
    blockers.push('repair_audit_archive_record_missing');
  }
  const ready = openIssues.length > 0 && blockers.length === 0;
  const stateMutationRecorded = repairStateMutationReceipt?.status === 'repair_state_mutation_recorded';
  const issueStateMutationPerformed = ready && (
    Boolean(issueQueueUpdateReceipt?.issueStateMutationPerformed)
    || Boolean(repairStateMutationReceipt?.issueStateMutationPerformed)
  );
  const sqliteWritePerformed = ready && (
    Boolean(issueQueueUpdateReceipt?.sqliteWritePerformed)
    || Boolean(repairStateMutationReceipt?.sqliteWritePerformed)
  );
  const submissionReadinessAdvanced = ready && (
    Boolean(submissionReadinessReentryGate?.submissionReadinessAdvanced)
    || Boolean(repairStateMutationReceipt?.reviewedSubmitReadinessReleased)
  );
  const reconciliation = {
    version: PAPER_CORE_VERSION,
    kind: 'RepairReconciliation',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssues.length
      ? 'no_repair_reconciliation_needed'
      : (blockers.length ? 'repair_reconciliation_blocked' : 'repair_reconciliation_ready'),
    repairReconciled: ready,
    submissionReadinessAdvanced,
    issueStateMutationPerformed,
    stateMutationRecorded,
    issueCount: issueQueue.issueCount,
    openIssueCount: openIssues.length,
    candidateIssueIds: issueResolutionProof?.candidateIssueIds || openIssues.map((issue) => issue.id),
    reconciledIssueIds: ready ? (issueResolutionProof?.resolvedIssueIds || openIssues.map((issue) => issue.id)) : [],
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
      postRepairBuildPackageHash: postRepairBuildPackage?.postRepairBuildPackageHash || null,
      issueResolutionProofHash: issueResolutionProof?.refereeIssueResolutionProofHash || null,
      rollbackReconciliationHash: rollbackReconciliation?.hash || rollbackReconciliation?.rollbackReconciliationHash || null,
      issueQueueUpdateReceiptHash: issueQueueUpdateReceipt?.hash || issueQueueUpdateReceipt?.issueQueueUpdateReceiptHash || null,
      patchQueueUpdateReceiptHash: patchQueueUpdateReceipt?.hash || patchQueueUpdateReceipt?.patchQueueUpdateReceiptHash || null,
      submissionReadinessReentryGateHash: submissionReadinessReentryGate?.hash || submissionReadinessReentryGate?.submissionReadinessReentryGateHash || null,
      repairAuditArchiveRecordHash: repairAuditArchiveRecord?.hash || repairAuditArchiveRecord?.repairAuditArchiveRecordHash || null,
      repairStateMutationReceiptHash: repairStateMutationReceipt?.repairStateMutationReceiptHash || null,
    },
    rollbackReconciliation,
    issueQueueUpdateReceipt,
    patchQueueUpdateReceipt,
    submissionReadinessReentryGate,
    repairAuditArchiveRecord,
    repairStateMutationReceipt,
    requiredReconciliationInputs: [
      'referee_issue_resolution_proof_ready',
      'post_repair_build_package_ready',
      'applied_patch_receipt_recorded',
      'rollback_ledger_reconciled',
      'issue_queue_update_receipt',
      'patch_queue_update_receipt',
      'submission_readiness_reentry_gate',
      'repair_audit_archive_record',
    ],
    blockedActionsUntilRepairReconciled: [
      'advance_reviewed_submit_readiness',
      'emit_repaired_submission_manifest',
      'close_referee_revision_batch',
      'archive_repaired_manuscript_as_final',
      'replace_current_package_as_active',
      'mark_repair_loop_complete',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      reconciliationOnly: true,
      marksIssuesResolved: issueStateMutationPerformed,
      writesSqlite: sqliteWritePerformed,
      writesSource: false,
      writesPackage: false,
      sourceMutation: false,
      externalActionPerformed: false,
      advancesSubmissionReadiness: submissionReadinessAdvanced,
      requiresIssueResolutionProof: true,
      requiresPostRepairPackage: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...reconciliation,
    repairReconciliationHash: hashPaperRecord('RepairReconciliation', reconciliation),
  };
}

export function buildRepairStateMutationReceipt({
  paperTask,
  issueQueue,
  issueResolutionProof = null,
  repairReconciliation = null,
  appliedPatchReceipt = null,
  execute = false,
  sqliteWritePerformed = false,
  issueRowsUpdated = 0,
  issueRowsAlreadyResolved = 0,
  patchRowsInserted = 0,
  patchRowsUpdated = 0,
  patchRowsAlreadyPresent = 0,
  issueRows = [],
  patchRows = [],
  errors = [],
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !issueQueue?.kind) {
    throw new Error('RepairStateMutationReceipt requires paperTask and issueQueue');
  }
  const openIssues = (issueQueue.issues || [])
    .filter((issue) => !['closed', 'resolved', 'applied', 'no_patch_needed'].includes(issue.status));
  const proofReady = issueResolutionProof?.status === 'referee_issue_resolution_proof_ready';
  const reconciliationReady = repairReconciliation?.status === 'repair_reconciliation_ready';
  const resolvedIssueIds = uniqueStrings(issueResolutionProof?.resolvedIssueIds || [], 256);
  const normalizedIssueRows = (issueRows || []).slice(0, 256).map((row, index) => ({
    id: normalizedId(row.id || row.requestKey || row.request_key || row.requestId, `${paperTask.paperId}:state-issue:${index + 1}`),
    requestId: Number.isFinite(Number(row.requestId || row.request_id)) ? Number(row.requestId || row.request_id) : null,
    requestKey: normalizeText(row.requestKey || row.request_key || '') || null,
    previousStatus: normalizeText(row.previousStatus || row.previous_status || '') || null,
    nextStatus: normalizeText(row.nextStatus || row.next_status || '') || null,
    stateReason: normalizeText(row.stateReason || row.state_reason || '') || null,
  }));
  const normalizedPatchRows = (patchRows || []).slice(0, 64).map((row, index) => ({
    id: normalizedId(row.id || row.patchId || row.patch_id || row.patchPath, `${paperTask.paperId}:state-patch:${index + 1}`),
    patchId: Number.isFinite(Number(row.patchId || row.patch_id)) ? Number(row.patchId || row.patch_id) : null,
    status: normalizeText(row.status || '') || null,
    patchPath: normalizeText(row.patchPath || row.patch_path || '') || null,
    patchSha256: normalizeText(row.patchSha256 || row.patch_sha256 || '') || null,
    action: normalizeText(row.action || '') || null,
  }));
  const receiptBlockers = [...(blockers || [])];
  if (openIssues.length && !execute) receiptBlockers.push('explicit_repair_state_mutation_execute_required');
  if (openIssues.length && !proofReady) receiptBlockers.push('referee_issue_resolution_proof_not_ready');
  if (openIssues.length && !reconciliationReady) receiptBlockers.push('repair_reconciliation_not_ready');
  if (openIssues.length && proofReady && !resolvedIssueIds.length) receiptBlockers.push('resolved_issue_ids_missing');
  for (const error of errors || []) {
    if (normalizeText(error)) receiptBlockers.push('sqlite_state_mutation_failed');
  }
  const recorded = openIssues.length > 0
    && Boolean(execute)
    && proofReady
    && reconciliationReady
    && Boolean(sqliteWritePerformed)
    && receiptBlockers.length === 0;
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'RepairStateMutationReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: !openIssues.length
      ? 'no_repair_state_mutation_needed'
      : (receiptBlockers.length ? 'repair_state_mutation_blocked' : 'repair_state_mutation_recorded'),
    executeRequested: Boolean(execute),
    issueCount: issueQueue.issueCount,
    openIssueCount: openIssues.length,
    resolvedIssueIds,
    issueRowsUpdated: Number(issueRowsUpdated) || 0,
    issueRowsAlreadyResolved: Number(issueRowsAlreadyResolved) || 0,
    patchRowsInserted: Number(patchRowsInserted) || 0,
    patchRowsUpdated: Number(patchRowsUpdated) || 0,
    patchRowsAlreadyPresent: Number(patchRowsAlreadyPresent) || 0,
    issueRows: normalizedIssueRows,
    patchRows: normalizedPatchRows,
    issueStateMutationPerformed: recorded,
    sqliteWritePerformed: recorded,
    reviewedSubmitReadinessReleased: recorded,
    hashChain: {
      issueQueueHash: issueQueue.refereeRevisionIssueQueueHash,
      issueResolutionProofHash: issueResolutionProof?.refereeIssueResolutionProofHash || null,
      repairReconciliationHash: repairReconciliation?.repairReconciliationHash || null,
      appliedPatchReceiptHash: appliedPatchReceipt?.refereeAppliedPatchReceiptHash || null,
    },
    blockers: uniqueStrings(receiptBlockers, 64),
    warnings: uniqueStrings(warnings || [], 64),
    errors: uniqueStrings(errors || [], 16),
    safety: {
      sqliteMutationExecutor: true,
      writesSqlite: recorded,
      marksIssuesResolved: recorded,
      writesSource: false,
      writesPackage: false,
      sourceMutation: false,
      externalActionPerformed: false,
      onlyResolvedMappedIssueIds: true,
      recordsAgentPatchQueueRows: true,
      releasesReviewedSubmitReadiness: recorded,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...receipt,
    repairStateMutationReceiptHash: hashPaperRecord('RepairStateMutationReceipt', receipt),
  };
}

export function buildSubmissionApprovalPacket({
  paperTask,
  mode = 'reviewed-submit',
  approved = false,
  approver = '',
  approvalActor = '',
  artifactPackage = null,
  venuePlan = null,
  researchReport = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('SubmissionApprovalPacket requires paperTask');
  const blockers = [];
  if (!approved) blockers.push('explicit_reviewed_submit_approval_required');
  if (!artifactPackage?.submitReady) blockers.push('artifact_package_not_submit_ready');
  if (venuePlan?.status !== 'local_dry_run_ready') blockers.push('venue_submission_plan_not_ready');
  if (researchReport?.status === 'blocked') blockers.push('research_verify_blocked');
  if (researchReport?.academicEvidenceStatus !== 'academic_evidence_verified'
    || researchReport?.academicEvidenceEligible !== true) {
    blockers.push('attested_academic_evidence_required_for_reviewed_submit');
  }
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmissionApprovalPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: normalizeText(mode) || 'reviewed-submit',
    status: blockers.length ? 'blocked_approval_packet' : 'approved_for_external_executor_handoff',
    approved: Boolean(approved) && blockers.length === 0,
    approver: normalizeText(approver) || null,
    approvalActor: normalizeText(approvalActor) || null,
    agentApproved: normalizeText(approvalActor) === 'agent' && Boolean(approved) && blockers.length === 0,
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
    researchReportHash: researchReport?.researchReportHash || researchReport?.researchVerifyReceiptHash || null,
    externalExecutorRequired: true,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      grantsLiveExecutionInsideOverlay: false,
      externalActionPerformed: false,
      requiresSeparateExecutor: true,
      agentMayApprove: true,
    },
    createdAt: createdAt || nowIso(),
  };
  const approvalHash = hashPaperRecord('SubmissionApprovalPacket', packet);
  return { ...packet, approvalHash, submissionApprovalPacketHash: approvalHash };
}

export function buildFreshVenueEvidenceBundle({
  paperTask,
  venuePlan,
  artifactPackage = null,
  researchReport = null,
  requireAcademicEvidence = false,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !venuePlan?.kind) throw new Error('FreshVenueEvidenceBundle requires paperTask and venuePlan');
  const blockers = [];
  if (venuePlan.status !== 'local_dry_run_ready') blockers.push('venue_plan_not_ready');
  if (!artifactPackage?.artifactPackageHash) blockers.push('artifact_package_hash_missing');
  if (requireAcademicEvidence && (
    researchReport?.academicEvidenceStatus !== 'academic_evidence_verified'
    || researchReport?.academicEvidenceEligible !== true
  )) {
    blockers.push('attested_academic_evidence_required_for_reviewed_submit');
  }
  const bundle = {
    version: PAPER_CORE_VERSION,
    kind: 'FreshVenueEvidenceBundle',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'blocked_fresh_venue_evidence' : 'fresh_venue_evidence_ready',
    venueSubmissionPlanHash: venuePlan.venueSubmissionPlanHash,
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    researchReportHash: researchReport?.researchReportHash || researchReport?.researchVerifyReceiptHash || null,
    academicEvidenceStatus: researchReport?.academicEvidenceStatus || null,
    academicEvidenceEligible: researchReport?.academicEvidenceEligible === true,
    evidenceRefs: normalizeRefs([
      ...(artifactPackage?.evidenceRefs || []),
      ...(researchReport?.evidenceRefs || []),
    ]),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      fetchedPortalState: false,
      externalActionPerformed: false,
      dryRunEvidenceOnly: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...bundle, freshVenueEvidenceBundleHash: hashPaperRecord('FreshVenueEvidenceBundle', bundle) };
}

export function buildSubmissionReplayGuard({
  manifest,
  venueEvidenceBundle = null,
  priorReceipt = null,
  createdAt = null,
} = {}) {
  if (!manifest?.kind) throw new Error('SubmissionReplayGuard requires manifest');
  const blockers = [];
  if (manifest.status !== PAPER_MANIFEST_STATUS.READY) blockers.push('manifest_not_ready');
  if (venueEvidenceBundle && venueEvidenceBundle.status !== 'fresh_venue_evidence_ready') blockers.push('fresh_venue_evidence_not_ready');
  if (priorReceipt?.externalActionPerformed) blockers.push('prior_external_action_already_performed');
  const guard = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmissionReplayGuard',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blockers.length ? 'blocked_replay_guard' : 'dry_run_replay_allowed',
    manifestHash: manifest.manifestHash,
    freshVenueEvidenceBundleHash: venueEvidenceBundle?.freshVenueEvidenceBundleHash || null,
    priorReceiptHash: priorReceipt?.receiptHash || null,
    replayKey: hashPaperRecord('SubmissionReplayKey', {
      paperId: manifest.paperId,
      action: manifest.action,
      manifestHash: manifest.manifestHash,
      freshVenueEvidenceBundleHash: venueEvidenceBundle?.freshVenueEvidenceBundleHash || null,
    }),
    blockers: uniqueStrings(blockers, 32),
    safety: {
      preventsDuplicateLiveAction: true,
      grantsExecutionPermission: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...guard, submissionReplayGuardHash: hashPaperRecord('SubmissionReplayGuard', guard) };
}

export function buildExternalExecutorHandoffOutbox({
  manifest,
  handoff,
  replayGuard,
  createdAt = null,
} = {}) {
  if (!manifest?.kind || !handoff?.kind || !replayGuard?.kind) throw new Error('ExternalExecutorHandoffOutbox requires manifest, handoff, and replayGuard');
  const blockers = [
    ...(manifest.blockers || []),
    ...(handoff.blockers || []),
    ...(replayGuard.blockers || []),
  ];
  const outbox = {
    version: PAPER_CORE_VERSION,
    kind: 'ExternalExecutorHandoffOutbox',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blockers.length ? 'blocked_outbox_item' : 'queued_for_dry_run_executor',
    manifestHash: manifest.manifestHash,
    handoffEnvelopeHash: handoff.envelopeHash,
    replayGuardHash: replayGuard.submissionReplayGuardHash,
    commandPreview: handoff.commandPreview,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      previewOnly: true,
      externalActionPerformed: false,
      sourceMutation: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...outbox, externalExecutorHandoffOutboxHash: hashPaperRecord('ExternalExecutorHandoffOutbox', outbox) };
}

export function buildReviewedSubmitPreflightPacket({
  paperTask,
  approvalPacket,
  freshVenueEvidenceBundle,
  manifest,
  replayGuard,
  outbox,
  artifactPackage = null,
  researchReport = null,
  venuePlan = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !approvalPacket?.kind || !freshVenueEvidenceBundle?.kind || !manifest?.kind || !replayGuard?.kind || !outbox?.kind) {
    throw new Error('ReviewedSubmitPreflightPacket requires paperTask, approvalPacket, freshVenueEvidenceBundle, manifest, replayGuard, and outbox');
  }
  const blockers = uniqueStrings([
    ...(approvalPacket.blockers || []),
    ...(freshVenueEvidenceBundle.blockers || []),
    ...(manifest.blockers || []),
    ...(replayGuard.blockers || []),
    ...(outbox.blockers || []),
  ], 64);
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'ReviewedSubmitPreflightPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    mode: 'reviewed-submit',
    status: blockers.length
      ? 'reviewed_submit_preflight_blocked'
      : 'reviewed_submit_preflight_ready_for_external_executor',
    externalExecutorHandoffReady: blockers.length === 0,
    approvalRequired: blockers.includes('explicit_reviewed_submit_approval_required') || !approvalPacket.approved,
    liveExecutorBoundaryBlocked: blockers.includes('live_submit_not_implemented_in_overlay'),
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    researchReportHash: researchReport?.researchReportHash || researchReport?.researchVerifyReceiptHash || null,
    venueSubmissionPlanHash: venuePlan?.venueSubmissionPlanHash || null,
    approvalHash: approvalPacket.approvalHash || approvalPacket.submissionApprovalPacketHash || null,
    freshVenueEvidenceBundleHash: freshVenueEvidenceBundle.freshVenueEvidenceBundleHash || null,
    manifestHash: manifest.manifestHash || null,
    replayGuardHash: replayGuard.submissionReplayGuardHash || null,
    outboxHash: outbox.externalExecutorHandoffOutboxHash || null,
    blockers,
    safety: {
      preflightOnly: true,
      grantsLiveExecutionInsideOverlay: false,
      requiresSeparateReviewedApproval: !approvalPacket.approved,
      requiresExternalExecutor: true,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    reviewedSubmitPreflightPacketHash: hashPaperRecord('ReviewedSubmitPreflightPacket', packet),
  };
}

export function buildControlledExternalExecutorReceipt({
  paperTask,
  approvalPacket,
  reviewedSubmitPreflightPacket,
  manifest,
  outbox,
  replayGuard,
  executorId = 'openclaw-agent-controlled-reviewed-submit-executor',
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !approvalPacket?.kind || !reviewedSubmitPreflightPacket?.kind || !manifest?.kind || !outbox?.kind || !replayGuard?.kind) {
    throw new Error('ControlledExternalExecutorReceipt requires paperTask, approvalPacket, reviewedSubmitPreflightPacket, manifest, outbox, and replayGuard');
  }
  const blockers = [];
  if (approvalPacket.status !== 'approved_for_external_executor_handoff') blockers.push('submission_approval_packet_not_ready');
  if (reviewedSubmitPreflightPacket.status !== 'reviewed_submit_preflight_ready_for_external_executor') {
    blockers.push('reviewed_submit_preflight_not_ready');
  }
  if (manifest.status !== PAPER_MANIFEST_STATUS.READY || !manifest.readyForAdapter) blockers.push('manifest_not_ready');
  if (outbox.status !== 'queued_for_dry_run_executor') blockers.push('executor_outbox_not_ready');
  if (replayGuard.status !== 'dry_run_replay_allowed') blockers.push('replay_guard_not_ready');
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'ControlledExternalExecutorReceipt',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    action: manifest.action,
    mode: 'reviewed-submit',
    status: blockers.length ? 'controlled_external_executor_blocked' : 'controlled_external_executor_receipt_recorded',
    executorId: normalizeText(executorId) || null,
    agentApproved: approvalPacket.agentApproved === true,
    controlledExecutorReady: blockers.length === 0,
    liveSubmitPerformed: false,
    externalActionPerformed: false,
    hashChain: {
      approvalHash: approvalPacket.approvalHash || approvalPacket.submissionApprovalPacketHash || null,
      reviewedSubmitPreflightPacketHash: reviewedSubmitPreflightPacket.reviewedSubmitPreflightPacketHash || null,
      manifestHash: manifest.manifestHash || null,
      outboxHash: outbox.externalExecutorHandoffOutboxHash || null,
      replayGuardHash: replayGuard.submissionReplayGuardHash || null,
    },
    blockers: uniqueStrings(blockers, 32),
    safety: {
      receiptOnly: true,
      grantsLiveExecutionInsideOverlay: false,
      executesExternalAction: false,
      externalActionPerformed: false,
      sourceMutation: false,
      liveSubmitPerformed: false,
      requiresSeparateRealPortalExecutor: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...receipt,
    controlledExternalExecutorReceiptHash: hashPaperRecord('ControlledExternalExecutorReceipt', receipt),
  };
}

export function buildExternalSubmissionReceipt({
  manifest,
  outbox,
  venuePlan,
  reviewedSubmit = false,
  createdAt = null,
} = {}) {
  if (!manifest?.kind || !outbox?.kind || !venuePlan?.kind) throw new Error('ExternalSubmissionReceipt requires manifest, outbox, and venuePlan');
  const blockers = [
    ...(manifest.blockers || []),
    ...(outbox.blockers || []),
  ];
  const receipt = {
    version: PAPER_CORE_VERSION,
    kind: 'ExternalSubmissionReceipt',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    action: manifest.action,
    status: blockers.length ? PAPER_RUN_RECEIPT_STATUS.BLOCKED : PAPER_RUN_RECEIPT_STATUS.DRY_RUN_RECORDED,
    result: blockers.length ? 'blocked' : 'dry_run_success',
    manifestHash: manifest.manifestHash,
    outboxHash: outbox.externalExecutorHandoffOutboxHash,
    venueSubmissionPlanHash: venuePlan.venueSubmissionPlanHash,
    reviewedSubmitRequested: Boolean(reviewedSubmit),
    externalActionPerformed: false,
    sourceMutationPerformed: false,
    blockers: uniqueStrings(blockers, 32),
    createdAt: createdAt || nowIso(),
  };
  const receiptHash = hashPaperRecord('ExternalSubmissionReceipt', receipt);
  return { ...receipt, receiptHash, externalSubmissionReceiptHash: receiptHash };
}

export function buildSubmissionReceiptInbox({
  receipt,
  outbox,
  createdAt = null,
} = {}) {
  if (!receipt?.kind || !outbox?.kind) throw new Error('SubmissionReceiptInbox requires receipt and outbox');
  const blockers = [];
  if (receipt.outboxHash !== outbox.externalExecutorHandoffOutboxHash) blockers.push('receipt_outbox_hash_mismatch');
  if (receipt.externalActionPerformed) blockers.push('unexpected_external_action_performed');
  const inbox = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmissionReceiptInbox',
    taskKey: receipt.taskKey,
    paperId: receipt.paperId,
    status: blockers.length ? 'blocked_receipt_inbox' : 'receipt_inbox_recorded',
    receiptHash: receipt.receiptHash,
    outboxHash: outbox.externalExecutorHandoffOutboxHash,
    blockers: uniqueStrings(blockers, 32),
    createdAt: createdAt || nowIso(),
  };
  return { ...inbox, submissionReceiptInboxHash: hashPaperRecord('SubmissionReceiptInbox', inbox) };
}

export function buildSubmissionReconciliation({
  manifest,
  outbox,
  receipt,
  venueStateProof,
  auditArchive = null,
  createdAt = null,
} = {}) {
  if (!manifest?.kind || !outbox?.kind || !receipt?.kind || !venueStateProof?.kind) {
    throw new Error('SubmissionReconciliation requires manifest, outbox, receipt, and venueStateProof');
  }
  const blockers = [];
  if (receipt.manifestHash !== manifest.manifestHash) blockers.push('receipt_manifest_hash_mismatch');
  if (receipt.outboxHash !== outbox.externalExecutorHandoffOutboxHash) blockers.push('receipt_outbox_hash_mismatch');
  if (venueStateProof.receiptHash !== receipt.receiptHash) blockers.push('proof_receipt_hash_mismatch');
  if (receipt.externalActionPerformed || venueStateProof.externalStateChanged) blockers.push('unexpected_external_state_change');
  const reconciliation = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmissionReconciliation',
    taskKey: manifest.taskKey,
    paperId: manifest.paperId,
    status: blockers.length ? 'blocked_reconciliation' : 'dry_run_reconciled',
    manifestHash: manifest.manifestHash,
    outboxHash: outbox.externalExecutorHandoffOutboxHash,
    receiptHash: receipt.receiptHash,
    venueStateProofHash: venueStateProof.venueStateProofHash,
    auditArchiveHash: auditArchive?.auditArchiveHash || null,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      externalActionPerformed: false,
      externalStateChanged: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...reconciliation, submissionReconciliationHash: hashPaperRecord('SubmissionReconciliation', reconciliation) };
}

export function buildVenueResolutionPacket({
  paperTask,
  submissionIntent = null,
  candidates = [],
  packageReady = false,
  sourceReady = false,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('VenueResolutionPacket requires paperTask');
  const normalizedCandidates = (candidates || []).slice(0, 12).map((candidate, index) => ({
    id: normalizedId(candidate.id || candidate.venue_id || candidate.venueId, `${paperTask.paperId}:venue:${index + 1}`),
    venueId: normalizeText(candidate.venue_id || candidate.venueId || candidate.id || '') || null,
    name: normalizeText(candidate.name || candidate.label || '') || null,
    kind: normalizeText(candidate.kind || '') || null,
    cycle: normalizeText(candidate.cycle || '') || null,
    score: Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : 0,
    reason: normalizeText(candidate.reason || '') || null,
  }));
  const blockers = [];
  const warnings = [];
  const intentStatus = normalizeText(submissionIntent?.status || 'unknown');
  if (intentStatus !== 'needs_venue_decision') warnings.push(`submission_intent_${intentStatus || 'unknown'}`);
  if (!sourceReady) blockers.push('source_not_ready_for_venue_resolution');
  if (!packageReady) blockers.push('package_not_submit_ready_for_venue_resolution');
  if (!normalizedCandidates.length) warnings.push('no_registry_venue_candidate');
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueResolutionPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    title: paperTask.title,
    status: blockers.length
      ? 'venue_resolution_waiting_for_local_package'
      : 'manual_venue_decision_required',
    submissionIntent: submissionIntent || null,
    candidateCount: normalizedCandidates.length,
    candidates: normalizedCandidates,
    recommendedOutcome: normalizedCandidates.length
      ? 'operator_select_venue_or_mark_non_submission'
      : 'operator_provide_venue_or_mark_non_submission',
    decisionOptions: [
      'select_existing_registry_venue',
      'add_new_registry_venue',
      'mark_non_submission_archive',
      'keep_pending_manual_decision',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      writesRegistry: false,
      writesSqlite: false,
      externalActionPerformed: false,
      choosesVenueAutomatically: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...packet, venueResolutionPacketHash: hashPaperRecord('VenueResolutionPacket', packet) };
}

export function buildSubmitReadyPackagePlan({
  paperTask,
  artifactPackage = null,
  buildStatus = null,
  blockers = [],
  warnings = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('SubmitReadyPackagePlan requires paperTask');
  const artifacts = artifactPackage?.artifacts || [];
  const hasPdf = artifacts.some((artifact) => artifact.role === 'compiled_pdf');
  const hasTex = Boolean(paperTask.mainTex) || artifacts.some((artifact) => ['main_tex', 'tex_source'].includes(artifact.role));
  const hasSourceZip = artifacts.some((artifact) => /zip/i.test(artifact.role || artifact.filename || ''));
  const planBlockers = [...(blockers || [])];
  const planWarnings = [...(warnings || [])];
  if (!hasPdf) planBlockers.push('compiled_pdf_required_for_submit_ready_package');
  if (!hasTex) planBlockers.push('tex_source_required_for_submit_ready_package');
  if (!hasSourceZip) planWarnings.push('source_zip_should_be_generated_before_submit');
  const requiredOutputs = [
    'compiled_pdf',
    'source_workspace_zip',
    'PACKAGE_RECORD.json',
    'SHA256SUMS.txt',
  ];
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'SubmitReadyPackagePlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: artifactPackage?.submitReady
      ? 'submit_ready_package_present'
      : 'submit_ready_package_plan_required',
    artifactPackageHash: artifactPackage?.artifactPackageHash || null,
    buildStatus: normalizeText(buildStatus || artifactPackage?.buildStatus || '') || null,
    hasPdf,
    hasTex,
    hasSourceZip,
    requiredOutputs,
    recommendedCommand: `paper-production-core batch-run --mode local-build --paper ${paperTask.paperId} --execute && paper-production-core batch-run --mode local-package --paper ${paperTask.paperId} --execute`,
    blockers: uniqueStrings(planBlockers, 32),
    warnings: uniqueStrings(planWarnings, 32),
    safety: {
      planOnly: true,
      writesSource: false,
      externalActionPerformed: false,
      executeRequiresExplicitFlag: true,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...plan, submitReadyPackagePlanHash: hashPaperRecord('SubmitReadyPackagePlan', plan) };
}

export function buildVenueRegistryAddPlan({
  paperTask,
  venueResolutionPacket,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !venueResolutionPacket?.kind) {
    throw new Error('VenueRegistryAddPlan requires paperTask and venueResolutionPacket');
  }
  const blockers = [];
  if (venueResolutionPacket.status !== 'manual_venue_decision_required') {
    blockers.push('venue_resolution_not_ready_for_registry_add');
  }
  const slug = normalizeText(paperTask.paperId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const plan = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueRegistryAddPlan',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'registry_add_plan_blocked' : 'registry_add_plan_requires_operator_target',
    venueResolutionPacketHash: venueResolutionPacket.venueResolutionPacketHash,
    proposedVenueRecordTemplate: {
      venue_id: `manual_${slug || 'venue'}`,
      name: '',
      kind: '',
      cycle: '',
      deadline: '',
      metadata_json: '{}',
    },
    requiredOperatorFields: ['name', 'kind'],
    optionalOperatorFields: ['venue_id', 'cycle', 'deadline', 'metadata_json'],
    decisionOptions: [
      'add_new_registry_venue_then_rerun_venue_resolve',
      'select_existing_registry_venue',
      'mark_non_submission_archive',
      'keep_pending_manual_decision',
    ],
    blockers: uniqueStrings(blockers, 32),
    safety: {
      planOnly: true,
      writesRegistry: false,
      writesSqlite: false,
      externalActionPerformed: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...plan, venueRegistryAddPlanHash: hashPaperRecord('VenueRegistryAddPlan', plan) };
}

export function buildVenueResolutionOperatorPacket({
  paperTask,
  venueResolutionPacket,
  submitReadyPackagePlan = null,
  venueRegistryAddPlan = null,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !venueResolutionPacket?.kind) {
    throw new Error('VenueResolutionOperatorPacket requires paperTask and venueResolutionPacket');
  }
  const blockers = [];
  if (venueResolutionPacket.status !== 'manual_venue_decision_required') {
    blockers.push('venue_resolution_packet_not_operator_ready');
  }
  if (submitReadyPackagePlan?.status === 'submit_ready_package_plan_required') {
    blockers.push('submit_ready_package_required_before_operator_venue_resolution');
  }
  const hasCandidates = Number(venueResolutionPacket.candidateCount || 0) > 0;
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'VenueResolutionOperatorPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length ? 'venue_operator_packet_blocked' : 'venue_operator_decision_ready',
    venueResolutionPacketHash: venueResolutionPacket.venueResolutionPacketHash,
    submitReadyPackagePlanHash: submitReadyPackagePlan?.submitReadyPackagePlanHash || null,
    venueRegistryAddPlanHash: venueRegistryAddPlan?.venueRegistryAddPlanHash || null,
    candidateCount: venueResolutionPacket.candidateCount || 0,
    requiredOperatorInputs: hasCandidates
      ? ['selected_venue_id_or_archive_decision', 'decision_rationale', 'operator_id', 'decision_timestamp']
      : ['venue_name_or_archive_decision', 'venue_kind', 'decision_rationale', 'operator_id', 'decision_timestamp'],
    acceptedOutcomes: [
      'select_existing_registry_venue',
      'add_new_registry_venue_then_rerun_venue_resolve',
      'mark_non_submission_archive',
      'keep_pending_manual_decision',
    ],
    acceptanceCriteria: [
      'decision_is_bound_to_venue_resolution_packet_hash',
      'selected_or_added_venue_has_name_and_kind',
      'submit_ready_package_is_present_before_active_submission_reentry',
      'rerun_local_dry_run_after_registry_or_archive_decision',
    ],
    nextCommands: [
      `paper-production-core batch-run --mode venue-resolve --paper ${paperTask.paperId} --write-report`,
      `paper-production-core batch-run --mode local-dry-run --paper ${paperTask.paperId} --write-report`,
    ],
    blockedActions: [
      'auto_select_venue',
      'silent_sqlite_registry_write',
      'external_submit_or_upload',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(venueResolutionPacket.warnings || [], 32),
    safety: {
      operatorPacketOnly: true,
      writesRegistry: false,
      writesSqlite: false,
      externalActionPerformed: false,
      choosesVenueAutomatically: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    venueResolutionOperatorPacketHash: hashPaperRecord('VenueResolutionOperatorPacket', packet),
  };
}

export function buildSourceAdaptationPacket({
  paperTask,
  submissionIntent = null,
  sourceWorkspace = null,
  texCandidates = [],
  pdfCandidates = [],
  codeCandidates = [],
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey) throw new Error('SourceAdaptationPacket requires paperTask');
  const normalizedTex = (texCandidates || []).slice(0, 32).map((candidate, index) => ({
    id: normalizedId(candidate.id, `${paperTask.paperId}:tex:${index + 1}`),
    path: normalizeText(candidate.path || '') || null,
    filename: normalizeText(candidate.filename || '') || null,
    role: normalizeText(candidate.role || 'tex_candidate') || 'tex_candidate',
    hash: normalizeText(candidate.hash || '') || null,
    score: Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : 0,
    reason: normalizeText(candidate.reason || '') || null,
  }));
  const normalizedPdfs = (pdfCandidates || []).slice(0, 16).map((candidate, index) => ({
    id: normalizedId(candidate.id, `${paperTask.paperId}:pdf:${index + 1}`),
    path: normalizeText(candidate.path || '') || null,
    filename: normalizeText(candidate.filename || '') || null,
    hash: normalizeText(candidate.hash || '') || null,
    sizeBytes: Number.isFinite(Number(candidate.sizeBytes)) ? Number(candidate.sizeBytes) : null,
  }));
  const normalizedCode = (codeCandidates || []).slice(0, 32).map((candidate, index) => ({
    id: normalizedId(candidate.id, `${paperTask.paperId}:code:${index + 1}`),
    path: normalizeText(candidate.path || '') || null,
    filename: normalizeText(candidate.filename || '') || null,
    hash: normalizeText(candidate.hash || '') || null,
  }));
  const blockers = [];
  const warnings = [];
  if (!sourceWorkspace) blockers.push('source_workspace_missing');
  if (!normalizedTex.length) blockers.push('main_tex_candidate_missing');
  if (normalizedPdfs.length && !normalizedTex.length) warnings.push('pdf_present_without_tex_source');
  if (normalizedCode.length && !normalizedTex.length) warnings.push('code_project_present_without_manuscript_source');
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'SourceAdaptationPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    title: paperTask.title,
    status: blockers.length
      ? 'manual_source_decision_required'
      : 'main_tex_candidate_review_required',
    submissionIntent: submissionIntent || null,
    sourceWorkspace: normalizeText(sourceWorkspace) || null,
    texCandidateCount: normalizedTex.length,
    pdfCandidateCount: normalizedPdfs.length,
    codeCandidateCount: normalizedCode.length,
    texCandidates: normalizedTex,
    pdfCandidates: normalizedPdfs,
    codeCandidates: normalizedCode,
    recommendedOutcome: normalizedTex.length
      ? 'operator_select_main_tex'
      : 'operator_supply_source_or_mark_non_submission_archive',
    decisionOptions: [
      'select_main_tex',
      'supply_missing_manuscript_source',
      'mark_non_submission_archive',
      'keep_pending_manual_source_decision',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(warnings, 32),
    safety: {
      writesSource: false,
      synthesizesMainTex: false,
      externalActionPerformed: false,
      choosesEntryPointAutomatically: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return { ...packet, sourceAdaptationPacketHash: hashPaperRecord('SourceAdaptationPacket', packet) };
}

export function buildSourceAdaptationOperatorPacket({
  paperTask,
  sourceAdaptationPacket,
  createdAt = null,
} = {}) {
  if (!paperTask?.taskKey || !sourceAdaptationPacket?.kind) {
    throw new Error('SourceAdaptationOperatorPacket requires paperTask and sourceAdaptationPacket');
  }
  const blockers = [];
  if (!['manual_source_decision_required', 'main_tex_candidate_review_required'].includes(sourceAdaptationPacket.status)) {
    blockers.push('source_adaptation_packet_not_operator_ready');
  }
  const hasTexCandidates = Number(sourceAdaptationPacket.texCandidateCount || 0) > 0;
  const packet = {
    version: PAPER_CORE_VERSION,
    kind: 'SourceAdaptationOperatorPacket',
    taskKey: paperTask.taskKey,
    paperId: paperTask.paperId,
    status: blockers.length
      ? 'source_operator_packet_blocked'
      : (hasTexCandidates ? 'main_tex_selection_ready' : 'source_material_decision_ready'),
    sourceAdaptationPacketHash: sourceAdaptationPacket.sourceAdaptationPacketHash,
    sourceWorkspace: sourceAdaptationPacket.sourceWorkspace || null,
    candidateSummary: {
      texCandidateCount: sourceAdaptationPacket.texCandidateCount || 0,
      pdfCandidateCount: sourceAdaptationPacket.pdfCandidateCount || 0,
      codeCandidateCount: sourceAdaptationPacket.codeCandidateCount || 0,
    },
    requiredOperatorInputs: hasTexCandidates
      ? ['selected_main_tex_path', 'decision_rationale', 'operator_id', 'decision_timestamp']
      : ['source_material_location_or_archive_decision', 'decision_rationale', 'operator_id', 'decision_timestamp'],
    acceptedOutcomes: [
      'select_existing_main_tex',
      'supply_missing_manuscript_source',
      'mark_non_submission_archive',
      'keep_pending_manual_source_decision',
    ],
    acceptanceCriteria: [
      'decision_is_bound_to_source_adaptation_packet_hash',
      'selected_main_tex_exists_and_is_hash_bound',
      'no_synthesized_main_tex_without_separate_authorization',
      'rerun_local_build_package_and_dry_run_after_source_decision',
    ],
    nextCommands: [
      `paper-production-core batch-run --mode source-adapt --paper ${paperTask.paperId} --write-report`,
      `paper-production-core batch-run --mode local-build --paper ${paperTask.paperId}`,
      `paper-production-core batch-run --mode local-package --paper ${paperTask.paperId}`,
    ],
    blockedActions: [
      'synthesize_main_tex',
      'mutate_source_workspace',
      'mark_source_ready_without_hash_bound_main_tex',
    ],
    blockers: uniqueStrings(blockers, 32),
    warnings: uniqueStrings(sourceAdaptationPacket.warnings || [], 32),
    safety: {
      operatorPacketOnly: true,
      writesSource: false,
      synthesizesMainTex: false,
      externalActionPerformed: false,
      choosesEntryPointAutomatically: false,
    },
    createdAt: createdAt || nowIso(),
  };
  return {
    ...packet,
    sourceAdaptationOperatorPacketHash: hashPaperRecord('SourceAdaptationOperatorPacket', packet),
  };
}
