import path from 'node:path';
import {
  buildPaperProposalGenerationReceipt,
  buildPaperProposalReviewGate,
  buildPaperTaskCreationEnvelope,
  createManuscriptSourceContract,
  createPaperIdeaBrief,
  createPaperProductionPlanEnvelope,
  createPaperProposalStagingRecord,
  createPaperTask,
  createPaperProposalEnvelope,
  createPaperProposalGenerationManifest,
  hashPaperRecord,
} from '../../paper-core/src/paper-contracts.mjs';
import {
  ensureDir,
  fileRecord,
  relativePath,
} from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../paper-core/src/runtime/text-utils.mjs';
import { nowIso } from '../../paper-core/src/runtime/time-utils.mjs';
import { defaultPaperRuntimeRoot } from '../../paper-core/src/workspace-layout.mjs';
import { writeJsonFile, writeTextFile } from '../artifacts/write-artifact.mjs';
import {
  buildJournalConferenceRegistry,
  buildJournalRubricPacket,
  buildJournalTargetProfile,
  buildTargetSelectionPolicy,
  buildVenueRubricManager,
} from '../journal-manage/index.mjs';

const DISCIPLINE_PROFILES = Object.freeze([
  {
    id: 'machine_learning',
    label: 'Machine learning',
    keywords: ['machine learning', 'neurips', 'icml', 'learning', 'neural', 'rl', 'optimization'],
    proposalEmphasis: ['novelty', 'algorithmic contribution', 'experiments', 'ablation', 'reproducibility'],
    defaultSections: ['Introduction', 'Related Work', 'Method', 'Theory or Analysis', 'Experiments', 'Limitations'],
  },
  {
    id: 'statistics',
    label: 'Statistics',
    keywords: ['statistics', 'aos', 'annals of statistics', 'estimator', 'asymptotic', 'inference'],
    proposalEmphasis: ['assumptions', 'identifiability', 'theorem statements', 'proof plan', 'simulation evidence'],
    defaultSections: ['Introduction', 'Model', 'Main Results', 'Proof Sketch', 'Simulations', 'Discussion'],
  },
  {
    id: 'economics_finance',
    label: 'Economics and finance',
    keywords: ['economics', 'finance', 'asset pricing', 'contract', 'equilibrium', 'market'],
    proposalEmphasis: ['economic mechanism', 'identification', 'comparative statics', 'empirical or theoretical support'],
    defaultSections: ['Introduction', 'Model', 'Main Mechanism', 'Results', 'Evidence', 'Implications'],
  },
  {
    id: 'operations_research',
    label: 'Operations research',
    keywords: ['operations research', 'or', 'control', 'queue', 'inventory', 'robust', 'stochastic control'],
    proposalEmphasis: ['modeling primitive', 'policy structure', 'performance guarantee', 'computational validation'],
    defaultSections: ['Introduction', 'Problem Formulation', 'Structural Results', 'Algorithms', 'Experiments', 'Managerial Insights'],
  },
  {
    id: 'mathematics',
    label: 'Mathematics',
    keywords: ['mathematics', 'annals', 'theorem', 'proof', 'lemma', 'geometry', 'analysis'],
    proposalEmphasis: ['precise definitions', 'main theorem', 'proof architecture', 'novel technique'],
    defaultSections: ['Introduction', 'Preliminaries', 'Main Theorem', 'Proof Strategy', 'Proofs', 'Examples'],
  },
]);

const VENUE_PROFILES = Object.freeze([
  {
    id: 'neurips',
    label: 'NeurIPS',
    keywords: ['neurips', 'nips'],
    requirements: ['clear ML novelty', 'strong experiments or theory', 'reproducibility checklist', 'limitations statement'],
  },
  {
    id: 'aos',
    label: 'Annals of Statistics',
    keywords: ['aos', 'annals of statistics'],
    requirements: ['mathematical rigor', 'statistical contribution', 'complete proof strategy', 'assumption clarity'],
  },
  {
    id: 'or',
    label: 'Operations Research',
    keywords: ['operations research', 'management science', 'or'],
    requirements: ['model relevance', 'theory or algorithmic contribution', 'managerial insight', 'computational evidence'],
  },
  {
    id: 'qje',
    label: 'Quarterly Journal of Economics',
    keywords: ['qje', 'quarterly journal of economics', 'economics', 'political economy'],
    requirements: ['major economics insight', 'credible empirical or theoretical design', 'broad field relevance'],
  },
  {
    id: 'journal_finance',
    label: 'Journal of Finance',
    keywords: ['journal of finance', 'finance', 'asset pricing', 'corporate finance'],
    requirements: ['first-order finance contribution', 'credible empirical or theoretical design', 'clear market relevance'],
  },
  {
    id: 'annals_math',
    label: 'Annals of Mathematics',
    keywords: ['annals of mathematics', 'annals math', 'mathematics', 'pure mathematics'],
    requirements: ['major mathematical theorem', 'complete proof', 'deep novelty'],
  },
  {
    id: 'nature',
    label: 'Nature',
    keywords: ['nature'],
    requirements: ['broad framing', 'high-level novelty', 'clear story', 'strong evidence package'],
  },
  {
    id: 'colt_focs',
    label: 'COLT/FOCS',
    keywords: ['colt', 'focs', 'stoc', 'theory'],
    requirements: ['formal problem statement', 'theorem novelty', 'proof depth', 'positioning against known bounds'],
  },
]);

function tokenText(values = []) {
  return values.map((value) => normalizeText(value).toLowerCase()).filter(Boolean).join(' ');
}

function pickProfile(profiles, hints, fallbackId) {
  const text = tokenText(hints);
  const tokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const scored = profiles.map((profile) => {
    const score = profile.keywords.reduce((sum, keyword) => {
      const normalized = keyword.toLowerCase();
      if (normalized.length <= 4) return sum + (tokens.has(normalized) ? 1 : 0);
      return sum + (text.includes(normalized) ? 1 : 0);
    }, 0);
    return { profile, score };
  }).sort((left, right) => right.score - left.score || left.profile.id.localeCompare(right.profile.id));
  return scored.find((item) => item.score > 0)?.profile
    || profiles.find((profile) => profile.id === fallbackId)
    || profiles[0];
}

function fallbackVenueIdForDiscipline(profile = {}) {
  if (profile.id === 'statistics') return 'aos';
  if (profile.id === 'operations_research') return 'operations_research';
  if (profile.id === 'mathematics') return 'annals_math';
  if (profile.id === 'economics_finance') return 'qje';
  return 'neurips';
}

function slugify(value) {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return slug || 'paper_proposal';
}

function sentence(value) {
  const text = normalizeText(value);
  return text.endsWith('.') ? text : `${text}.`;
}

function buildDeterministicProposal({ ideaBrief, disciplineProfile, venueProfile }) {
  const title = ideaBrief.title
    || `A ${disciplineProfile.label} Study of ${normalizeText(ideaBrief.idea).slice(0, 80)}`;
  const contributionClaims = uniqueStrings([
    `Define a venue-scoped research question around: ${ideaBrief.idea}`,
    `Establish a ${disciplineProfile.label.toLowerCase()} contribution aligned with ${venueProfile.label}`,
    'Produce a hash-bound evidence, proof, or reproducibility plan before manuscript production',
  ], 8);
  const proofObligations = uniqueStrings([
    ...disciplineProfile.proposalEmphasis
      .filter((item) => /theorem|proof|assumption|guarantee|formal|rigor/i.test(item))
      .map((item) => `Clarify ${item}`),
    'List assumptions and boundary cases before claiming venue readiness',
  ], 8);
  const evidencePlan = uniqueStrings([
    ...disciplineProfile.proposalEmphasis
      .filter((item) => /experiment|evidence|simulation|reproducibility|empirical|validation/i.test(item))
      .map((item) => `Prepare ${item}`),
    ...venueProfile.requirements.map((item) => `Satisfy venue requirement: ${item}`),
  ], 12);
  const requiredArtifacts = uniqueStrings([
    'proposal_review_packet',
    'manuscript_outline',
    'claim_scope_contract',
    'proof_obligation_contract',
    'evidence_matrix_contract',
    'reproducibility_contract',
    'venue_fit_assessment',
  ], 12);
  return {
    tentativeTitle: title,
    abstract: sentence(`${title} proposes to develop ${ideaBrief.idea} for ${venueProfile.label}, with an initial production plan focused on ${disciplineProfile.proposalEmphasis.slice(0, 3).join(', ')}`),
    centralThesis: sentence(`The central thesis is that ${ideaBrief.idea} can be turned into a ${disciplineProfile.label.toLowerCase()} paper if its claims, evidence, and venue fit pass explicit review gates`),
    contributionClaims,
    expectedStructure: disciplineProfile.defaultSections,
    proofObligations,
    evidencePlan,
    reproducibilityPlan: [
      'Record all source, data, code, proof, and package artifacts by hash',
      'Require a reproducibility contract before local dry-run submission readiness',
    ],
    venueFit: `${venueProfile.label}: ${venueProfile.requirements.join('; ')}`,
    noveltyRisk: 'requires_literature_and_competing_claim_scan',
    feasibilityRisk: 'requires_operator_review_before_paper_task_creation',
    requiredArtifacts,
    warnings: ideaBrief.materials.length ? [] : ['initial_materials_not_supplied'],
  };
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

async function materializeApprovedProposal({
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

async function stageApprovedProposalForInventory({
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
  approved = false,
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
  const journalConferenceRegistry = buildJournalConferenceRegistry();
  const venueFallbackId = fallbackVenueIdForDiscipline(disciplineProfile);
  const preliminaryTargetSelectionPolicy = buildTargetSelectionPolicy({
    target: venue || null,
    hints: [discipline, paperType, title, idea],
    registry: journalConferenceRegistry,
    fallbackId: venueFallbackId,
  });
  const preliminaryJournalProfile = buildJournalTargetProfile({
    target: venue || null,
    registry: journalConferenceRegistry,
    targetSelectionPolicy: preliminaryTargetSelectionPolicy,
    hints: [discipline, paperType, title, idea],
    fallbackId: venueFallbackId,
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
  });
  const targetJournalProfile = buildJournalTargetProfile({
    paperTask: proposalPaperTask,
    target: ideaBrief.targetVenue,
    registry: journalConferenceRegistry,
    targetSelectionPolicy,
    hints: [discipline, paperType, title, idea],
    fallbackId: venueFallbackId,
  });
  const venueRubricManager = buildVenueRubricManager({
    paperTask: proposalPaperTask,
    targetProfile: targetJournalProfile,
    targetSelectionPolicy,
  });
  const journalRubricPacket = buildJournalRubricPacket({
    paperTask: proposalPaperTask,
    targetProfile: targetJournalProfile,
    targetSelectionPolicy,
    venueRubricManager,
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
    proposal: buildDeterministicProposal({ ideaBrief, disciplineProfile, venueProfile: selectedVenueProfile }),
  });
  const generationReceipt = buildPaperProposalGenerationReceipt({
    generationManifest,
    proposalEnvelope,
  });
  const reviewGate = buildPaperProposalReviewGate({
    proposalEnvelope,
    generationReceipt,
    approved,
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
      productionPlanEnvelope,
      reviewGate,
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
      proposalEnvelope,
      productionPlanEnvelope,
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
    },
  };
  return { ...report, paperProposalAdapterReportHash: hashPaperRecord('PaperProposalAdapterReport', report) };
}
