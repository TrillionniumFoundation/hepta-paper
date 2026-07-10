import { normalizeText, nowIso, uniqueStrings } from './utils.mjs';
import {
  PAPER_CORE_VERSION,
  PAPER_MANIFEST_STATUS,
  PAPER_RUN_RECEIPT_STATUS,
  hashPaperRecord,
  normalizedId,
  normalizeRefs,
} from './paper-contract-primitives.mjs';
export {
  PAPER_CORE_VERSION,
  PAPER_MANIFEST_STATUS,
  PAPER_RUN_RECEIPT_STATUS,
  hashPaperRecord,
} from './paper-contract-primitives.mjs';

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
  if (blockerSet.has('live_submit_not_implemented_in_overlay')
    || blockerSet.has('explicit_reviewed_submit_approval_required')
    || blockerSet.has('attested_academic_evidence_required_for_reviewed_submit')
    || blockerSet.has('independent_referee_acceptance_authority_required')
    || blockerSet.has('live_submission_authorization_required')) {
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
  if (blockerSet.has('live_submit_not_implemented_in_overlay')
    || blockerSet.has('explicit_reviewed_submit_approval_required')
    || blockerSet.has('attested_academic_evidence_required_for_reviewed_submit')
    || blockerSet.has('independent_referee_acceptance_authority_required')
    || blockerSet.has('live_submission_authorization_required')) {
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
      independentRefereeAuthorityReceiptHash:
        approvalPacket?.independentRefereeAuthorityReceiptHash || null,
      liveSubmissionAuthorizationReceiptHash:
        approvalPacket?.liveSubmissionAuthorizationReceiptHash || null,
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
      cryptographicDualControlRequired: normalizedAction === PAPER_ACTIONS.REVIEWED_SUBMIT,
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

export {
  buildAgentRefereeReviewReport,
  buildRefereeIssueQueueMaterialization,
  buildRefereeReviewIntake,
  buildRefereeRevisionApplyModeContract,
  buildRefereeRevisionDryRunReceipt,
  buildRefereeRevisionExecuteDesignPacket,
  buildRefereeRevisionExecutePlan,
  buildRefereeRevisionIssueQueue,
  buildRefereeRevisionPatchExecutionPreflight,
  buildRefereeRevisionPatchPlan,
  buildRefereeRevisionPreimageSnapshotLedger,
  buildRefereeRevisionRollbackLedgerDraft,
} from './contracts/referee-planning.mjs';
export {
  buildRefereeAppliedPatchReceipt,
  buildRefereeApplyApprovalPacket,
  buildRefereePatchApplyExecution,
  buildRefereePatchApplyInvocation,
} from './contracts/referee-application.mjs';
export {
  buildPostRepairBuildPackage,
  buildRefereeIssueResolutionProof,
  buildRepairReconciliation,
  buildRepairStateMutationReceipt,
} from './contracts/referee-closure.mjs';
export {
  buildControlledExternalExecutorReceipt,
  buildExternalExecutorHandoffOutbox,
  buildExternalSubmissionReceipt,
  buildFreshVenueEvidenceBundle,
  buildReviewedSubmitPreflightPacket,
  buildSubmissionApprovalPacket,
  buildSubmissionReceiptInbox,
  buildSubmissionReconciliation,
  buildSubmissionReplayGuard,
} from './contracts/submission.mjs';
export {
  buildSourceAdaptationOperatorPacket,
  buildSourceAdaptationPacket,
  buildSubmitReadyPackagePlan,
  buildVenueRegistryAddPlan,
  buildVenueResolutionOperatorPacket,
  buildVenueResolutionPacket,
} from './contracts/intake-resolution.mjs';
