import path from 'node:path';
import {
  buildPaperTaskCreationEnvelope,
  createManuscriptSourceContract,
  createPaperProposalStagingRecord,
  createPaperTask,
  hashPaperRecord,
} from '../../paper-domain/contracts/index.mjs';
import { ensureDir, fileRecord, relativePath } from '../../workflow-kernel/runtime/file-utils.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import {
  assertWorkspaceLayoutPhysicallyDecoupled,
  defaultPaperRuntimeRoot,
} from '../../paper-adapters/runtime/workspace-layout.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';
import { verifyPaperProposalApproval } from './proposal-approval-verification.mjs';
import { verifyPaperScientificClaimInput } from '../../paper-domain/contracts/scientific-claim-input.mjs';

function hashBoundRecordValid(record, recordType, hashField) {
  if (!record || typeof record !== 'object' || !record[hashField]) return false;
  const { [hashField]: claimedHash, ...payload } = record;
  return hashPaperRecord(recordType, payload) === claimedHash;
}

function proposalAuthorityLineageBlockers({
  proposalEnvelope,
  generationReceipt,
  productionPlanEnvelope,
  reviewGate,
  approvalDocument,
  approvalVerification,
} = {}) {
  const blockers = [];
  if (!hashBoundRecordValid(proposalEnvelope, 'PaperProposalEnvelope', 'paperProposalEnvelopeHash')) {
    blockers.push('proposal_envelope_hash_invalid');
  }
  if (!hashBoundRecordValid(
    generationReceipt,
    'PaperProposalGenerationReceipt',
    'paperProposalGenerationReceiptHash',
  )) blockers.push('proposal_generation_receipt_hash_invalid');
  if (generationReceipt?.proposalEnvelopeHash !== proposalEnvelope?.paperProposalEnvelopeHash) {
    blockers.push('proposal_generation_receipt_lineage_mismatch');
  }
  if (!hashBoundRecordValid(reviewGate, 'PaperProposalReviewGate', 'paperProposalReviewGateHash')) {
    blockers.push('proposal_review_gate_hash_invalid');
  }
  if (reviewGate?.proposalEnvelopeHash !== proposalEnvelope?.paperProposalEnvelopeHash
    || reviewGate?.generationReceiptHash !== generationReceipt?.paperProposalGenerationReceiptHash) {
    blockers.push('proposal_review_gate_lineage_mismatch');
  }
  if (!hashBoundRecordValid(
    productionPlanEnvelope,
    'PaperProductionPlanEnvelope',
    'paperProductionPlanEnvelopeHash',
  )) blockers.push('proposal_production_plan_hash_invalid');
  if (productionPlanEnvelope?.proposalEnvelopeHash !== proposalEnvelope?.paperProposalEnvelopeHash
    || productionPlanEnvelope?.reviewGateHash !== reviewGate?.paperProposalReviewGateHash) {
    blockers.push('proposal_production_plan_lineage_mismatch');
  }
  if (!hashBoundRecordValid(
    approvalVerification,
    'PaperProposalApprovalVerificationReceipt',
    'paperProposalApprovalVerificationReceiptHash',
  )) blockers.push('proposal_approval_verification_receipt_hash_invalid');
  const approvalDocumentHash = approvalDocument && typeof approvalDocument === 'object'
    ? hashPaperRecord('PaperProposalApprovalDocument', approvalDocument)
    : null;
  if (approvalVerification?.status !== 'proposal_approval_verified'
    || approvalVerification?.proposalEnvelopeHash !== proposalEnvelope?.paperProposalEnvelopeHash
    || approvalVerification?.generationReceiptHash !== generationReceipt?.paperProposalGenerationReceiptHash
    || approvalVerification?.approvalDocumentHash !== approvalDocumentHash) {
    blockers.push('proposal_approval_verification_lineage_mismatch');
  }
  if (reviewGate?.status !== 'proposal_approved_for_production_plan'
    || reviewGate?.approved !== true
    || reviewGate?.approvalDocumentHash !== approvalDocumentHash
    || reviewGate?.approvalVerificationReceiptHash
      !== approvalVerification?.paperProposalApprovalVerificationReceiptHash) {
    blockers.push('proposal_review_gate_not_cryptographically_approved');
  }
  return blockers;
}

function formalScientificClaimLineageBlockers(proposalEnvelope) {
  const proposal = proposalEnvelope?.proposal || {};
  if (!(proposal.recommendedPaperQualityProfiles || []).includes('formal_theorem_or_proof')) return [];
  const input = proposal.scientificClaimInput;
  const blockers = [];
  const verification = verifyPaperScientificClaimInput(input);
  if (!verification.valid) blockers.push(...verification.blockers);
  const claims = Array.isArray(input?.claims) ? input.claims : [];
  if (!claims.length
    || claims.length !== (proposal.contributionClaims || []).length
    || claims.some((claim, index) => claim?.statement !== proposal.contributionClaims[index]
      || !Array.isArray(claim?.assumptions) || claim.assumptions.length === 0
      || !Array.isArray(claim?.quantifiers) || claim.quantifiers.length === 0
      || !Array.isArray(claim?.negativeBoundaries) || claim.negativeBoundaries.length === 0
      || !Array.isArray(claim?.proofObligations) || claim.proofObligations.length === 0)) {
    blockers.push('formal_scientific_claim_input_projection_invalid');
  }
  const projectedObligations = [...new Set(claims.flatMap((claim) => claim?.proofObligations || []))];
  if (JSON.stringify(projectedObligations) !== JSON.stringify(proposal.proofObligations || [])) {
    blockers.push('formal_scientific_claim_proof_obligations_mismatch');
  }
  return blockers;
}

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
  approvalVerification,
} = {}) {
  const proposal = proposalEnvelope?.proposal || {};
  const scientificClaimInput = proposal.scientificClaimInput || null;
  const evidenceRef = {
    kind: 'proposal_seed',
    ref: proposalEnvelope?.paperProposalEnvelopeHash || '',
    hash: proposalEnvelope?.paperProposalEnvelopeHash || null,
  };
  const claims = (proposal.contributionClaims || []).map((claim, index) => {
    const scientific = scientificClaimInput?.claims?.[index] || null;
    return {
      id: `${paperTask.paperId}:proposal_claim:${index + 1}`,
      kind: 'proposal_claim_seed',
      text: claim,
      status: 'proposal_seed',
      sourceLocator: 'PaperProposalEnvelope.proposal.contributionClaims',
      scientificClaimInputHash: scientificClaimInput?.paperScientificClaimInputHash || null,
      scientificClaimKey: scientific?.claimKey || null,
      assumptions: scientific?.assumptions || [],
      quantifiers: scientific?.quantifiers || [],
      negativeBoundaries: scientific?.negativeBoundaries || [],
      proofObligations: scientific?.proofObligations || [],
      evidenceRefs: [evidenceRef],
    };
  });
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
    approvalDocumentHash: approvalVerification.approvalDocumentHash,
    approvalVerificationReceiptHash:
      approvalVerification.paperProposalApprovalVerificationReceiptHash,
    scientificClaimInputHash: scientificClaimInput?.paperScientificClaimInputHash || null,
    claims,
    proof_obligations: proofObligations,
    evidence,
    reproducibility,
    blockers,
    warnings: [
      'proposal_seed_contracts_require_real_evidence_followup',
      'scientific_claim_novelty_and_correctness_not_automatically_verified',
    ],
    safety: {
      proposalDerivedOnly: true,
      operatorScientificClaimInputBound: Boolean(scientificClaimInput),
      noveltyAutomaticallyVerified: false,
      scientificCorrectnessAutomaticallyVerified: false,
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
  generationReceipt,
  productionPlanEnvelope,
  reviewGate,
  approvalDocument = null,
  trustStoreOverride = null,
  now = new Date(),
  journalConferenceRegistry = null,
  targetSelectionPolicy = null,
  targetJournalProfile = null,
  journalRubricPacket = null,
  venueRubricManager = null,
  createdAt = null,
} = {}) {
  const blockers = [];
  const materializedAt = createdAt || nowIso();
  const resolvedRuntimeRoot = runtimeRoot || (root ? defaultPaperRuntimeRoot() : null);
  const approvalVerification = await verifyPaperProposalApproval({
    ideaBrief,
    proposalEnvelope,
    generationReceipt,
    approvalDocument,
    runtimeRoot: resolvedRuntimeRoot,
    trustStoreOverride,
    now,
  });
  blockers.push(...proposalAuthorityLineageBlockers({
    proposalEnvelope,
    generationReceipt,
    productionPlanEnvelope,
    reviewGate,
    approvalDocument,
    approvalVerification,
  }));
  blockers.push(...formalScientificClaimLineageBlockers(proposalEnvelope));
  if (!root) blockers.push('root_required_for_materialization');
  if (productionPlanEnvelope?.status !== 'production_plan_ready') blockers.push('production_plan_not_ready');
  const paperId = proposalEnvelope?.paperId || 'paper_proposal';
  const recommendedPaperQualityProfiles = proposalEnvelope?.proposal?.recommendedPaperQualityProfiles || [];
  const sourceDir = resolvedRuntimeRoot ? path.join(resolvedRuntimeRoot, 'proposals', paperId, 'source') : null;
  const mainTexPath = sourceDir ? path.join(sourceDir, 'main.tex') : null;
  const recordPath = sourceDir ? path.join(sourceDir, 'PROPOSAL_SOURCE_RECORD.json') : null;
  const readmePath = sourceDir ? path.join(sourceDir, 'README.md') : null;
  const journalRegistryPath = sourceDir ? path.join(sourceDir, 'JOURNAL_CONFERENCE_REGISTRY.json') : null;
  const targetSelectionPath = sourceDir ? path.join(sourceDir, 'TARGET_SELECTION_POLICY.json') : null;
  const journalProfilePath = sourceDir ? path.join(sourceDir, 'JOURNAL_TARGET_PROFILE.json') : null;
  const journalRubricPath = sourceDir ? path.join(sourceDir, 'JOURNAL_RUBRIC_PACKET.json') : null;
  const venueRubricPath = sourceDir ? path.join(sourceDir, 'VENUE_RUBRIC_MANAGER.json') : null;
  const approvalDocumentPath = sourceDir ? path.join(sourceDir, 'PROPOSAL_APPROVAL_DOCUMENT.json') : null;
  const approvalVerificationPath = sourceDir
    ? path.join(sourceDir, 'PROPOSAL_APPROVAL_VERIFICATION_RECEIPT.json')
    : null;
  const scientificClaimInputPath = sourceDir && proposalEnvelope?.proposal?.scientificClaimInput
    ? path.join(sourceDir, 'SCIENTIFIC_CLAIM_INPUT.json')
    : null;
  const seedContractsPath = sourceDir
    ? path.join(sourceDir, 'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json')
    : null;
  let records = [];
  let seedContractBundle = null;
  let seedContractRecord = null;
  const materializedFileRecord = async (candidate, role) => {
    const record = await fileRecord(resolvedRuntimeRoot, candidate, role);
    return record ? { ...record, path: relativePath(root, candidate) } : null;
  };
  if (!blockers.length) {
    assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot: resolvedRuntimeRoot });
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
    await writeJsonFile(approvalDocumentPath, approvalDocument);
    await writeJsonFile(approvalVerificationPath, approvalVerification);
    if (scientificClaimInputPath) {
      await writeJsonFile(scientificClaimInputPath, proposalEnvelope.proposal.scientificClaimInput);
    }
    await writeJsonFile(recordPath, {
      version: 1,
      kind: 'ProposalSourceRecord',
      paperId,
      proposalEnvelopeHash: proposalEnvelope.paperProposalEnvelopeHash,
      productionPlanEnvelopeHash: productionPlanEnvelope.paperProductionPlanEnvelopeHash,
      reviewGateHash: reviewGate.paperProposalReviewGateHash,
      approvalDocumentHash: approvalVerification.approvalDocumentHash,
      approvalVerificationReceiptHash:
        approvalVerification.paperProposalApprovalVerificationReceiptHash,
      approvedOperatorSubjectId: approvalVerification.operatorIdentity.subjectId,
      scientificClaimInputHash:
        proposalEnvelope.proposal?.scientificClaimInput?.paperScientificClaimInputHash || null,
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
      materializedFileRecord(mainTexPath, 'main_tex'),
      materializedFileRecord(readmePath, 'proposal_readme'),
      materializedFileRecord(recordPath, 'proposal_source_record'),
      materializedFileRecord(approvalDocumentPath, 'proposal_approval_document'),
      materializedFileRecord(approvalVerificationPath, 'proposal_approval_verification_receipt'),
      scientificClaimInputPath
        ? materializedFileRecord(scientificClaimInputPath, 'scientific_claim_input')
        : null,
      journalConferenceRegistry?.kind ? materializedFileRecord(journalRegistryPath, 'journal_conference_registry') : null,
      targetSelectionPolicy?.kind ? materializedFileRecord(targetSelectionPath, 'target_selection_policy') : null,
      targetJournalProfile?.kind ? materializedFileRecord(journalProfilePath, 'journal_target_profile') : null,
      journalRubricPacket?.kind ? materializedFileRecord(journalRubricPath, 'journal_rubric_packet') : null,
      venueRubricManager?.kind ? materializedFileRecord(venueRubricPath, 'venue_rubric_manager') : null,
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
        approvalDocumentHash: approvalVerification.approvalDocumentHash,
        approvalVerificationReceiptHash:
          approvalVerification.paperProposalApprovalVerificationReceiptHash,
        approvedOperatorSubjectId: approvalVerification.operatorIdentity.subjectId,
        scientificClaimInputHash:
          proposalEnvelope.proposal?.scientificClaimInput?.paperScientificClaimInputHash || null,
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
      paperQualityProfile: recommendedPaperQualityProfiles[0] || null,
      paperQualityProfiles: recommendedPaperQualityProfiles,
      createdAt: materializedAt,
    })
    : null;
  if (paperTask && seedContractsPath) {
    seedContractBundle = buildProposalSeedContractBundle({
      paperTask,
      proposalEnvelope,
      productionPlanEnvelope,
      reviewGate,
      approvalVerification,
    });
    await writeJsonFile(seedContractsPath, seedContractBundle);
    seedContractRecord = await materializedFileRecord(seedContractsPath, 'proposal_seed_contracts');
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
          approvalDocumentHash: approvalVerification.approvalDocumentHash,
          approvalVerificationReceiptHash:
            approvalVerification.paperProposalApprovalVerificationReceiptHash,
          approvedOperatorSubjectId: approvalVerification.operatorIdentity.subjectId,
          proposalSeedContractBundleHash: seedContractBundle.paperProposalSeedContractBundleHash,
          scientificClaimInputHash:
            proposalEnvelope.proposal?.scientificClaimInput?.paperScientificClaimInputHash || null,
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
        paperQualityProfile: recommendedPaperQualityProfiles[0] || null,
        paperQualityProfiles: recommendedPaperQualityProfiles,
        createdAt: materializedAt,
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
    approvalVerification,
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
      proposalApprovalDocumentWritten: records.some((record) => record.role === 'proposal_approval_document'),
      scientificClaimInputWritten: records.some((record) => record.role === 'scientific_claim_input'),
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
  ideaBrief,
  proposalEnvelope,
  generationReceipt,
  productionPlanEnvelope,
  reviewGate,
  approvalDocument = null,
  trustStoreOverride = null,
  now = new Date(),
  materialization,
} = {}) {
  const blockers = [];
  const approvalVerification = await verifyPaperProposalApproval({
    ideaBrief,
    proposalEnvelope,
    generationReceipt,
    approvalDocument,
    runtimeRoot,
    trustStoreOverride,
    now,
  });
  blockers.push(...proposalAuthorityLineageBlockers({
    proposalEnvelope,
    generationReceipt,
    productionPlanEnvelope,
    reviewGate,
    approvalDocument,
    approvalVerification,
  }));
  if (!root) blockers.push('root_required_for_staging');
  if (!runtimeRoot) blockers.push('runtime_root_required_for_staging');
  if (materialization?.status !== 'paper_task_draft_materialized') blockers.push('paper_task_draft_not_materialized');
  if (materialization?.approvalVerification?.paperProposalApprovalVerificationReceiptHash
      !== approvalVerification.paperProposalApprovalVerificationReceiptHash
    || materialization?.paperTask?.registry?.approvalDocumentHash
      !== approvalVerification.approvalDocumentHash
    || materialization?.paperTask?.registry?.approvalVerificationReceiptHash
      !== approvalVerification.paperProposalApprovalVerificationReceiptHash) {
    blockers.push('proposal_materialization_approval_lineage_mismatch');
  }
  const paperId = proposalEnvelope?.paperId || materialization?.paperTask?.paperId || 'paper_proposal';
  const stagingDir = runtimeRoot ? path.join(runtimeRoot, 'proposal-staging') : null;
  const stagingPath = stagingDir ? path.join(stagingDir, `${paperId}.json`) : null;
  const stagingRecord = createPaperProposalStagingRecord({
    proposalEnvelope,
    productionPlanEnvelope,
    approvalVerification,
    manuscriptSourceContract: materialization?.manuscriptSourceContract,
    paperTaskCreationEnvelope: materialization?.paperTaskCreationEnvelope,
    paperTask: materialization?.paperTask,
    seedContractBundle: materialization?.seedContractBundle,
    stagingPath: stagingPath ? relativePath(root, stagingPath) : null,
    blockers,
  });
  if (!stagingRecord.blockers.length && stagingPath) {
    assertWorkspaceLayoutPhysicallyDecoupled({ assetRoot: root, runtimeRoot });
    await ensureDir(stagingDir);
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
    approvalVerification,
    safety: {
      stagingOnly: true,
      writesProductionRegistry: false,
      writesLegacySource: false,
      externalActionPerformed: false,
      modelCallPerformed: false,
    },
  };
}
