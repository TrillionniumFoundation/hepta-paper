import {
  buildPaperProposalGenerationReceipt,
  buildPaperProposalReviewGate,
  createPaperIdeaBrief,
  createPaperProductionPlanEnvelope,
  createPaperProposalEnvelope,
  createPaperProposalGenerationManifest,
  hashPaperRecord,
} from '../../paper-domain/contracts/index.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import {
  buildJournalConferenceRegistry,
  buildJournalRubricPacket,
  buildJournalTargetProfile,
  buildTargetSelectionPolicy,
  buildVenueRubricManager,
} from '../../paper-domain/journal/contracts.mjs';
import {
  DISCIPLINE_PROFILES,
  VENUE_PROFILES,
  buildDeterministicProposal,
  fallbackVenueIdForDiscipline,
  pickProfile,
  slugify,
} from './proposal-generation.mjs';
import {
  materializeApprovedProposal,
  stageApprovedProposalForInventory,
} from './proposal-materialization.mjs';
import { verifyPaperProposalApproval } from './proposal-approval-verification.mjs';

export async function runPaperProposalAdapter({
  root = null,
  runtimeRoot = null,
  idea,
  paperId = null,
  title = null,
  discipline = null,
  venue = null,
  paperType = null,
  materials = [],
  constraints = [],
  riskPreference = null,
  scientificClaimDocument = null,
  approvalDocument = null,
  trustStoreOverride = null,
  now = new Date(),
  materializeSource = false,
  stageInventory = false,
} = {}) {
  const disciplineProfile = pickProfile(
    DISCIPLINE_PROFILES,
    [discipline, venue, paperType, title, idea],
    'machine_learning',
  );
  const venueProfile = pickProfile(
    VENUE_PROFILES,
    [venue, discipline, paperType, title, idea],
    fallbackVenueIdForDiscipline(disciplineProfile) === 'operations_research'
      ? 'or'
      : fallbackVenueIdForDiscipline(disciplineProfile),
  );
  const createdAt = nowIso();
  const journalConferenceRegistry = buildJournalConferenceRegistry({ createdAt });
  const venueFallbackId = fallbackVenueIdForDiscipline(disciplineProfile);
  const preliminaryTargetSelectionPolicy = buildTargetSelectionPolicy({
    target: venue || null,
    hints: [discipline, paperType, title, idea],
    registry: journalConferenceRegistry,
    fallbackId: venueFallbackId,
    createdAt,
  });
  const preliminaryJournalProfile = buildJournalTargetProfile({
    target: venue || null,
    registry: journalConferenceRegistry,
    targetSelectionPolicy: preliminaryTargetSelectionPolicy,
    hints: [discipline, paperType, title, idea],
    fallbackId: venueFallbackId,
    createdAt,
  });
  const ideaBrief = createPaperIdeaBrief({
    idea,
    paperId: paperId || slugify(title || idea),
    title,
    discipline: discipline || disciplineProfile.label,
    targetVenue: venue
      || preliminaryTargetSelectionPolicy.primaryTarget?.label
      || preliminaryJournalProfile.profile.label
      || venueProfile.label,
    paperType,
    materials,
    constraints,
    riskPreference,
  });
  const proposalPaperTask = {
    paperId: ideaBrief.paperId,
    taskKey: `paper_factory:${ideaBrief.paperId}`,
    title: ideaBrief.title || title || ideaBrief.idea,
    paperType: ideaBrief.paperType || paperType,
    venueTarget: ideaBrief.targetVenue,
  };
  const targetSelectionPolicy = buildTargetSelectionPolicy({
    paperTask: {
      ...proposalPaperTask,
      venueTarget: venue || null,
    },
    target: venue || null,
    hints: [discipline, paperType, title, idea],
    registry: journalConferenceRegistry,
    fallbackId: venueFallbackId,
    createdAt,
  });
  const targetJournalProfile = buildJournalTargetProfile({
    paperTask: proposalPaperTask,
    target: ideaBrief.targetVenue,
    registry: journalConferenceRegistry,
    targetSelectionPolicy,
    hints: [discipline, paperType, title, idea],
    fallbackId: venueFallbackId,
    createdAt,
  });
  const venueRubricManager = buildVenueRubricManager({
    paperTask: proposalPaperTask,
    targetProfile: targetJournalProfile,
    targetSelectionPolicy,
    createdAt,
  });
  const journalRubricPacket = buildJournalRubricPacket({
    paperTask: proposalPaperTask,
    targetProfile: targetJournalProfile,
    targetSelectionPolicy,
    venueRubricManager,
    createdAt,
  });
  const selectedVenueProfile = targetJournalProfile.profile || venueProfile;
  const generationManifest = createPaperProposalGenerationManifest({
    ideaBrief,
    disciplineProfile,
    venueProfile: selectedVenueProfile,
    promptTemplate: {
      id: `paper-proposal-${disciplineProfile.id}-${selectedVenueProfile.id}-v1`,
      source: 'paper-adapters/proposal',
      modelCallRequired: false,
      selectedFrom: [
        `paper-profiles/${disciplineProfile.id}.md`,
        `journal-profiles/${selectedVenueProfile.id}.json`,
      ],
    },
  });
  const proposalEnvelope = createPaperProposalEnvelope({
    ideaBrief,
    generationManifest,
    proposal: buildDeterministicProposal({
      ideaBrief,
      disciplineProfile,
      venueProfile: selectedVenueProfile,
      scientificClaimDocument,
    }),
  });
  const generationReceipt = buildPaperProposalGenerationReceipt({
    generationManifest,
    proposalEnvelope,
  });
  const approvalVerification = await verifyPaperProposalApproval({
    ideaBrief,
    proposalEnvelope,
    generationReceipt,
    approvalDocument,
    runtimeRoot,
    trustStoreOverride,
    now,
  });
  const reviewGate = buildPaperProposalReviewGate({
    proposalEnvelope,
    generationReceipt,
    approvalVerification,
  });
  const productionPlanEnvelope = createPaperProductionPlanEnvelope({
    proposalEnvelope,
    reviewGate,
  });
  const materialization = materializeSource
    ? await materializeApprovedProposal({
      root,
      runtimeRoot,
      ideaBrief,
      proposalEnvelope,
      generationReceipt,
      productionPlanEnvelope,
      reviewGate,
      approvalDocument,
      trustStoreOverride,
      now,
      journalConferenceRegistry,
      targetSelectionPolicy,
      targetJournalProfile,
      journalRubricPacket,
      venueRubricManager,
    })
    : null;
  const inventoryStaging = stageInventory
    ? await stageApprovedProposalForInventory({
      root,
      runtimeRoot: runtimeRoot || (root ? defaultPaperRuntimeRoot() : null),
      ideaBrief,
      proposalEnvelope,
      generationReceipt,
      productionPlanEnvelope,
      reviewGate,
      approvalDocument,
      trustStoreOverride,
      now,
      materialization,
    })
    : null;
  const report = {
    version: 1,
    kind: 'PaperProposalAdapterReport',
    generatedAt: nowIso(),
    status: materialization?.status
      || (reviewGate.approved ? 'proposal_approved_for_production_plan' : 'proposal_draft_waiting_for_review'),
    ideaBrief,
    generationManifest,
    proposalEnvelope,
    generationReceipt,
    approvalVerification,
    reviewGate,
    productionPlanEnvelope,
    journalConferenceRegistry,
    targetSelectionPolicy,
    targetJournalProfile,
    journalRubricPacket,
    venueRubricManager,
    materialization,
    inventoryStaging,
    summary: {
      paperId: ideaBrief.paperId,
      disciplineProfile: disciplineProfile.id,
      venueProfile: selectedVenueProfile.id,
      journalConferenceRegistryStatus: journalConferenceRegistry.status,
      targetSelectionStatus: targetSelectionPolicy.status,
      targetSelectionMode: targetSelectionPolicy.selectionMode,
      targetSelectionAutoSelected: targetSelectionPolicy.autoSelected,
      targetJournalProfile: targetJournalProfile.profile?.id || null,
      targetJournalStatus: targetJournalProfile.status,
      journalRubricStatus: journalRubricPacket.status,
      venueRubricManagerStatus: venueRubricManager.status,
      proposalStatus: proposalEnvelope.status,
      recommendedPaperQualityProfiles: proposalEnvelope.proposal?.recommendedPaperQualityProfiles || [],
      scientificClaimInputStatus: proposalEnvelope.proposal?.scientificClaimInput?.status || 'not_supplied',
      scientificClaimInputHash:
        proposalEnvelope.proposal?.scientificClaimInput?.paperScientificClaimInputHash || null,
      approvalStatus: approvalVerification.status,
      approvalDocumentHash: approvalVerification.approvalDocumentHash,
      approvalOperatorSubjectId: approvalVerification.operatorIdentity?.subjectId || null,
      reviewStatus: reviewGate.status,
      productionPlanStatus: productionPlanEnvelope.status,
      materializationStatus: materialization?.status || 'not_requested',
      inventoryStagingStatus: inventoryStaging?.status || 'not_requested',
      paperTaskDraftReady: materialization?.paperTaskCreationEnvelope?.status === 'paper_task_draft_ready',
      sourceSkeletonWritten: materialization?.status === 'paper_task_draft_materialized',
      seedContractsWritten: Boolean(materialization?.seedContractRecord),
      stagedForInventory: inventoryStaging?.status === 'proposal_inventory_staged',
      modelCallPerformed: false,
      externalActionPerformed: false,
      sourceMutation: false,
    },
    safety: {
      localOnly: true,
      modelCallPerformed: false,
      sourceMutation: false,
      externalActionPerformed: false,
      createsPaperTask: materialization?.paperTaskCreationEnvelope?.status === 'paper_task_draft_ready',
      createsInventoryStaging: inventoryStaging?.status === 'proposal_inventory_staged',
      createsProposalSeedContracts: Boolean(materialization?.seedContractRecord),
      proposalApprovalAuthorityVerified: approvalVerification.status === 'proposal_approval_verified',
      scientificClaimNoveltyAutomaticallyVerified: false,
      scientificClaimCorrectnessAutomaticallyVerified: false,
    },
  };
  return { ...report, paperProposalAdapterReportHash: hashPaperRecord('PaperProposalAdapterReport', report) };
}
