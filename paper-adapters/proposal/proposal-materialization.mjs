import path from 'node:path';
import {
  buildPaperTaskCreationEnvelope,
  createManuscriptSourceContract,
  createPaperProposalStagingRecord,
  createPaperTask,
  hashPaperRecord,
} from '../../paper-core/src/paper-contracts.mjs';
import { ensureDir, fileRecord, relativePath } from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText } from '../../paper-core/src/runtime/text-utils.mjs';
import { nowIso } from '../../paper-core/src/runtime/time-utils.mjs';
import { defaultPaperRuntimeRoot } from '../../paper-core/src/workspace-layout.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';

function texEscape(value) {
  return normalizeText(value)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1');
}

function latexSkeleton({ proposalEnvelope }) {
  const proposal = proposalEnvelope.proposal || {};
  const title = texEscape(proposal.tentativeTitle || proposalEnvelope.title || proposalEnvelope.paperId);
  const abstract = texEscape(proposal.abstract || '');
  const sections = (proposal.expectedStructure || ['Introduction', 'Main Results', 'Discussion'])
    .map((section) => `\\section{${texEscape(section)}}\n% TODO: materialize this section from the approved production plan.\n`)
    .join('\n');
  return [
    '\\documentclass[11pt]{article}',
    '\\usepackage[margin=1in]{geometry}',
    '\\usepackage{amsmath,amssymb,amsthm}',
    '\\title{' + title + '}',
    '\\author{}',
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    '\\begin{abstract}',
    abstract,
    '\\end{abstract}',
    '',
    sections,
    '\\end{document}',
    '',
  ].join('\n');
}

function buildProposalSeedContractBundle({
  paperTask,
  proposalEnvelope,
  productionPlanEnvelope,
  reviewGate,
} = {}) {
  const proposal = proposalEnvelope?.proposal || {};
  const evidenceRef = {
    kind: 'proposal_seed',
    ref: proposalEnvelope?.paperProposalEnvelopeHash || '',
    hash: proposalEnvelope?.paperProposalEnvelopeHash || null,
  };
  const claims = (proposal.contributionClaims || []).map((claim, index) => ({
    id: `${paperTask.paperId}:proposal_claim:${index + 1}`,
    kind: 'proposal_claim_seed',
    text: claim,
    status: 'proposal_seed',
    sourceLocator: 'PaperProposalEnvelope.proposal.contributionClaims',
    evidenceRefs: [evidenceRef],
  }));
  const proofObligations = (proposal.proofObligations || []).map((obligation, index) => ({
    id: `${paperTask.paperId}:proposal_proof:${index + 1}`,
    kind: 'proposal_proof_obligation_seed',
    text: obligation,
    status: 'proposal_seed',
    sourceLocator: 'PaperProposalEnvelope.proposal.proofObligations',
    evidenceRefs: [evidenceRef],
  }));
  const evidence = (proposal.evidencePlan || []).map((item, index) => ({
    id: `${paperTask.paperId}:proposal_evidence:${index + 1}`,
    kind: 'proposal_evidence_plan_seed',
    text: item,
    status: 'proposal_seed',
    sourceLocator: 'PaperProposalEnvelope.proposal.evidencePlan',
    evidenceRefs: [evidenceRef],
  }));
  const reproducibility = (proposal.reproducibilityPlan || []).map((item, index) => ({
    id: `${paperTask.paperId}:proposal_repro:${index + 1}`,
    kind: 'proposal_reproducibility_seed',
    text: item,
    status: 'proposal_seed',
    sourceLocator: 'PaperProposalEnvelope.proposal.reproducibilityPlan',
    evidenceRefs: [evidenceRef],
  }));
  const blockers = [];
  if (!claims.length) blockers.push('proposal_claim_seed_missing');
  if (!evidence.length) blockers.push('proposal_evidence_seed_missing');
  const bundle = {
    version: 1,
    kind: 'PaperProposalSeedContractBundle',
    paperId: paperTask.paperId,
    taskKey: paperTask.taskKey,
    status: blockers.length ? 'proposal_seed_contracts_blocked' : 'proposal_seed_contracts_ready',
    proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
    productionPlanEnvelopeHash: productionPlanEnvelope.paperProductionPlanEnvelopeHash,
    reviewGateHash: reviewGate.paperProposalReviewGateHash,
    claims,
    proof_obligations: proofObligations,
    evidence,
    reproducibility,
    blockers,
    warnings: ['proposal_seed_contracts_require_real_evidence_followup'],
    safety: {
      proposalDerivedOnly: true,
      claimsMachineCheckedProof: false,
      modelCallPerformed: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt: nowIso(),
  };
  return {
    ...bundle,
    paperProposalSeedContractBundleHash: hashPaperRecord('PaperProposalSeedContractBundle', bundle),
  };
}

export async function materializeApprovedProposal({
  root,
  runtimeRoot,
  ideaBrief,
  proposalEnvelope,
  productionPlanEnvelope,
  reviewGate,
  journalConferenceRegistry = null,
  targetSelectionPolicy = null,
  targetJournalProfile = null,
  journalRubricPacket = null,
  venueRubricManager = null,
} = {}) {
  const blockers = [];
  if (!root) blockers.push('root_required_for_materialization');
  if (reviewGate?.status !== 'proposal_approved_for_production_plan') blockers.push('proposal_review_gate_not_approved');
  if (productionPlanEnvelope?.status !== 'production_plan_ready') blockers.push('production_plan_not_ready');
  const paperId = proposalEnvelope?.paperId || 'paper_proposal';
  const resolvedRuntimeRoot = runtimeRoot || (root ? defaultPaperRuntimeRoot() : null);
  const sourceDir = resolvedRuntimeRoot ? path.join(resolvedRuntimeRoot, 'proposals', paperId, 'source') : null;
  const mainTexPath = sourceDir ? path.join(sourceDir, 'main.tex') : null;
  const recordPath = sourceDir ? path.join(sourceDir, 'PROPOSAL_SOURCE_RECORD.json') : null;
  const readmePath = sourceDir ? path.join(sourceDir, 'README.md') : null;
  const journalRegistryPath = sourceDir ? path.join(sourceDir, 'JOURNAL_CONFERENCE_REGISTRY.json') : null;
  const targetSelectionPath = sourceDir ? path.join(sourceDir, 'TARGET_SELECTION_POLICY.json') : null;
  const journalProfilePath = sourceDir ? path.join(sourceDir, 'JOURNAL_TARGET_PROFILE.json') : null;
  const journalRubricPath = sourceDir ? path.join(sourceDir, 'JOURNAL_RUBRIC_PACKET.json') : null;
  const venueRubricPath = sourceDir ? path.join(sourceDir, 'VENUE_RUBRIC_MANAGER.json') : null;
  const seedContractsPath = sourceDir
    ? path.join(sourceDir, 'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json')
    : null;
  let records = [];
  let seedContractBundle = null;
  let seedContractRecord = null;
  if (!blockers.length) {
    await ensureDir(sourceDir);
    await writeTextFile(mainTexPath, latexSkeleton({ proposalEnvelope }));
    await writeTextFile(readmePath, [
      `# ${proposalEnvelope.title || paperId}`,
      '',
      'Generated from an approved hepta-paper proposal.',
      '',
      '- This is a local source skeleton only.',
      '- It does not register the paper in the production inventory.',
      '- It does not perform external submission or model calls.',
      '',
    ].join('\n'));
    await writeJsonFile(recordPath, {
      version: 1,
      kind: 'ProposalSourceRecord',
      paperId,
      proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
      productionPlanEnvelopeHash: productionPlanEnvelope.paperProductionPlanEnvelopeHash,
      reviewGateHash: reviewGate.paperProposalReviewGateHash,
      generatedAt: nowIso(),
      safety: {
        localOnly: true,
        writesRegistry: false,
        writesLegacySource: false,
        externalActionPerformed: false,
        modelCallPerformed: false,
      },
    });
    if (journalConferenceRegistry?.kind) {
      await writeJsonFile(journalRegistryPath, journalConferenceRegistry);
    }
    if (targetSelectionPolicy?.kind) {
      await writeJsonFile(targetSelectionPath, targetSelectionPolicy);
    }
    if (targetJournalProfile?.kind) {
      await writeJsonFile(journalProfilePath, targetJournalProfile);
    }
    if (journalRubricPacket?.kind) {
      await writeJsonFile(journalRubricPath, journalRubricPacket);
    }
    if (venueRubricManager?.kind) {
      await writeJsonFile(venueRubricPath, venueRubricManager);
    }
    records = (await Promise.all([
      fileRecord(root, mainTexPath, 'main_tex'),
      fileRecord(root, readmePath, 'proposal_readme'),
      fileRecord(root, recordPath, 'proposal_source_record'),
      journalConferenceRegistry?.kind ? fileRecord(root, journalRegistryPath, 'journal_conference_registry') : null,
      targetSelectionPolicy?.kind ? fileRecord(root, targetSelectionPath, 'target_selection_policy') : null,
      targetJournalProfile?.kind ? fileRecord(root, journalProfilePath, 'journal_target_profile') : null,
      journalRubricPacket?.kind ? fileRecord(root, journalRubricPath, 'journal_rubric_packet') : null,
      venueRubricManager?.kind ? fileRecord(root, venueRubricPath, 'venue_rubric_manager') : null,
    ])).filter(Boolean);
  }
  let manuscriptSourceContract = createManuscriptSourceContract({
    proposalEnvelope,
    productionPlanEnvelope,
    sourceWorkspace: sourceDir ? relativePath(root, sourceDir) : null,
    mainTex: mainTexPath ? relativePath(root, mainTexPath) : null,
    outline: proposalEnvelope.proposal?.expectedStructure || [],
    createdArtifacts: records,
    blockers,
  });
  let paperTask = manuscriptSourceContract.status === 'manuscript_source_skeleton_ready'
    ? createPaperTask({
      paperId,
      title: proposalEnvelope.title,
      status: 'proposal_approved_source_skeleton',
      venueTarget: ideaBrief?.targetVenue || null,
      sourceWorkspace: manuscriptSourceContract.sourceWorkspace,
      mainTex: manuscriptSourceContract.mainTex,
      registry: {
        inventorySource: 'proposal_materialization',
        proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
        productionPlanEnvelopeHash: productionPlanEnvelope.paperProductionPlanEnvelopeHash,
        reviewGateHash: reviewGate.paperProposalReviewGateHash,
        journalConferenceRegistryHash: journalConferenceRegistry?.journalConferenceRegistryHash || null,
        targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || null,
        journalTargetProfileHash: targetJournalProfile?.journalTargetProfileHash || null,
        journalRubricPacketHash: journalRubricPacket?.journalRubricPacketHash || null,
        venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
      },
      source: {
        exists: true,
        candidateDirs: manuscriptSourceContract.sourceWorkspace ? [manuscriptSourceContract.sourceWorkspace] : [],
        sourceDir: manuscriptSourceContract.sourceWorkspace,
        sourceSkeleton: true,
      },
      evidenceRefs: records,
    })
    : null;
  if (paperTask && seedContractsPath) {
    seedContractBundle = buildProposalSeedContractBundle({
      paperTask,
      proposalEnvelope,
      productionPlanEnvelope,
      reviewGate,
    });
    await writeJsonFile(seedContractsPath, seedContractBundle);
    seedContractRecord = await fileRecord(root, seedContractsPath, 'proposal_seed_contracts');
    if (seedContractRecord) {
      records = [...records, seedContractRecord];
      manuscriptSourceContract = createManuscriptSourceContract({
        proposalEnvelope,
        productionPlanEnvelope,
        sourceWorkspace: sourceDir ? relativePath(root, sourceDir) : null,
        mainTex: mainTexPath ? relativePath(root, mainTexPath) : null,
        outline: proposalEnvelope.proposal?.expectedStructure || [],
        createdArtifacts: records,
        blockers,
      });
      paperTask = createPaperTask({
        paperId,
        title: proposalEnvelope.title,
        status: 'proposal_approved_source_skeleton',
        venueTarget: ideaBrief?.targetVenue || null,
        sourceWorkspace: manuscriptSourceContract.sourceWorkspace,
        mainTex: manuscriptSourceContract.mainTex,
        registry: {
          inventorySource: 'proposal_materialization',
          proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
          productionPlanEnvelopeHash: productionPlanEnvelope.paperProductionPlanEnvelopeHash,
        reviewGateHash: reviewGate.paperProposalReviewGateHash,
        proposalSeedContractBundleHash: seedContractBundle.paperProposalSeedContractBundleHash,
        journalConferenceRegistryHash: journalConferenceRegistry?.journalConferenceRegistryHash || null,
        targetSelectionPolicyHash: targetSelectionPolicy?.targetSelectionPolicyHash || null,
        journalTargetProfileHash: targetJournalProfile?.journalTargetProfileHash || null,
        journalRubricPacketHash: journalRubricPacket?.journalRubricPacketHash || null,
        venueRubricManagerHash: venueRubricManager?.venueRubricManagerHash || null,
      },
        source: {
          exists: true,
          candidateDirs: manuscriptSourceContract.sourceWorkspace ? [manuscriptSourceContract.sourceWorkspace] : [],
          sourceDir: manuscriptSourceContract.sourceWorkspace,
          sourceSkeleton: true,
          proposalSeedContracts: seedContractRecord.path,
        },
        evidenceRefs: records,
      });
    }
  }
  const paperTaskCreationEnvelope = buildPaperTaskCreationEnvelope({
    proposalEnvelope,
    productionPlanEnvelope,
    manuscriptSourceContract,
    paperTask,
  });
  return {
    version: 1,
    kind: 'PaperProposalMaterialization',
    status: paperTaskCreationEnvelope.status === 'paper_task_draft_ready'
      ? 'paper_task_draft_materialized'
      : 'paper_task_draft_blocked',
    sourceWorkspace: manuscriptSourceContract.sourceWorkspace,
    mainTex: manuscriptSourceContract.mainTex,
    records,
    seedContractBundle,
    seedContractRecord,
    manuscriptSourceContract,
    paperTask,
    paperTaskCreationEnvelope,
    safety: {
      localOnly: true,
      writesRegistry: false,
      writesLegacySource: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
      proposalSeedContractsWritten: Boolean(seedContractRecord),
      journalConferenceRegistryWritten: Boolean(journalConferenceRegistry?.kind),
      targetSelectionPolicyWritten: Boolean(targetSelectionPolicy?.kind),
      journalProfileWritten: Boolean(targetJournalProfile?.kind),
      journalRubricWritten: Boolean(journalRubricPacket?.kind),
      venueRubricManagerWritten: Boolean(venueRubricManager?.kind),
    },
  };
}

export async function stageApprovedProposalForInventory({
  root,
  runtimeRoot,
  proposalEnvelope,
  productionPlanEnvelope,
  materialization,
} = {}) {
  const blockers = [];
  if (!root) blockers.push('root_required_for_staging');
  if (!runtimeRoot) blockers.push('runtime_root_required_for_staging');
  if (materialization?.status !== 'paper_task_draft_materialized') blockers.push('paper_task_draft_not_materialized');
  const paperId = proposalEnvelope?.paperId || materialization?.paperTask?.paperId || 'paper_proposal';
  const stagingDir = runtimeRoot ? path.join(runtimeRoot, 'proposal-staging') : null;
  const stagingPath = stagingDir ? path.join(stagingDir, `${paperId}.json`) : null;
  const stagingRecord = createPaperProposalStagingRecord({
    proposalEnvelope,
    productionPlanEnvelope,
    manuscriptSourceContract: materialization?.manuscriptSourceContract,
    paperTaskCreationEnvelope: materialization?.paperTaskCreationEnvelope,
    paperTask: materialization?.paperTask,
    seedContractBundle: materialization?.seedContractBundle,
    stagingPath: stagingPath ? relativePath(root, stagingPath) : null,
    blockers,
  });
  if (!stagingRecord.blockers.length && stagingPath) {
    await writeJsonFile(stagingPath, stagingRecord);
  }
  return {
    version: 1,
    kind: 'PaperProposalInventoryStaging',
    status: stagingRecord.status === 'proposal_staged_for_inventory'
      ? 'proposal_inventory_staged'
      : 'proposal_inventory_staging_blocked',
    stagingPath: stagingPath ? relativePath(root, stagingPath) : null,
    stagingRecord,
    safety: {
      stagingOnly: true,
      writesProductionRegistry: false,
      writesLegacySource: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
  };
}

