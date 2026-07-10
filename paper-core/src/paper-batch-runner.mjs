import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ensureDir,
  nowIso,
  normalizeText,
  safeJsonParse,
  writeJsonFile,
  writeTextFile,
} from './utils.mjs';
import {
  PAPER_ACTIONS,
  createPaperWorkflowState,
  autoLevelForState,
  inferPaperStage,
  nextActionForState,
  paperWorkflowRow,
  hashPaperRecord,
} from './paper-contracts.mjs';
import { discoverInventory } from '../../paper-adapters/inventory/index.mjs';
import {
  runLatexBuildAdapter,
  runPackageAdapter,
} from '../../paper-adapters/build-package/index.mjs';
import { runEmpiricalAnalysisAdapter } from '../../paper-adapters/empirical-analysis/index.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import { runRefereeReviewAdapter } from '../../paper-adapters/referee-review/index.mjs';
import { runRefereeReviseAdapter } from '../../paper-adapters/referee-revise/index.mjs';
import { runVenueResolveAdapter } from '../../paper-adapters/venue-resolve/index.mjs';
import { runSourceAdaptAdapter } from '../../paper-adapters/source-adapt/index.mjs';
import { buildSubmissionLifecycle } from '../../paper-adapters/submission/index.mjs';
import { runLegacyCleanupAdapter } from '../../paper-adapters/legacy-cleanup/index.mjs';
import {
  buildFreshRefereeVerdict,
  buildFreshRefereePool,
  buildJournalConferenceRegistry,
  buildJournalConferenceSystemPacket,
  buildJournalRubricPacket,
  buildJournalTargetProfile,
  buildTargetSelectionPolicy,
  buildVenueEvidenceGate,
  buildVenueLifecyclePolicy,
  buildVenueRubricManager,
  runJournalManageAdapter,
} from '../../paper-adapters/journal-manage/index.mjs';

export const PAPER_BATCH_MODES = Object.freeze({
  INVENTORY: 'inventory',
  LOCAL_BUILD: 'local-build',
  LOCAL_PACKAGE: 'local-package',
  REFEREE_REVIEW: 'referee-review',
  REFEREE_REVISE: 'referee-revise',
  REFEREE_AUTOPILOT: 'referee-autopilot',
  EMPIRICAL_ANALYSIS: 'empirical-analysis',
  JOURNAL_MANAGE: 'journal-manage',
  VENUE_RESOLVE: 'venue-resolve',
  SOURCE_ADAPT: 'source-adapt',
  LOCAL_DRY_RUN: 'local-dry-run',
  REVIEWED_SUBMIT: 'reviewed-submit',
  LEGACY_CLEANUP: 'legacy-cleanup',
});

const MODE_SET = new Set(Object.values(PAPER_BATCH_MODES));

function defaultRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
}

function defaultRuntimeRoot(root) {
  return path.join(root, 'hepta-paper-workspace', 'runtime');
}

function sqliteJson(dbPath, sql) {
  const result = spawnSync('sqlite3', ['-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  return safeJsonParse(result.stdout || '[]', []);
}

function escapeSqlText(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function openRefereeIssueCount(root, paperId) {
  const dbPath = path.join(root, 'paper_factory.sqlite');
  const rows = sqliteJson(
    dbPath,
    [
      'select count(*) as count from referee_revision_requests',
      `where slug='${escapeSqlText(paperId)}'`,
      "and status not in ('resolved','closed');",
    ].join(' '),
  );
  return Number(rows[0]?.count || 0);
}

function modeNeedsBuild(mode) {
  return [
    PAPER_BATCH_MODES.LOCAL_BUILD,
    PAPER_BATCH_MODES.LOCAL_PACKAGE,
    PAPER_BATCH_MODES.VENUE_RESOLVE,
    PAPER_BATCH_MODES.LOCAL_DRY_RUN,
    PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  ].includes(mode);
}

function modeNeedsPackage(mode) {
  return [
    PAPER_BATCH_MODES.LOCAL_PACKAGE,
    PAPER_BATCH_MODES.VENUE_RESOLVE,
    PAPER_BATCH_MODES.LOCAL_DRY_RUN,
    PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  ].includes(mode);
}

function modeNeedsResearch(mode) {
  return [
    PAPER_BATCH_MODES.LOCAL_DRY_RUN,
    PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  ].includes(mode);
}

function modeNeedsRefereeRevise(mode) {
  return mode === PAPER_BATCH_MODES.REFEREE_REVISE;
}

function modeNeedsRefereeReview(mode) {
  return mode === PAPER_BATCH_MODES.REFEREE_REVIEW;
}

function modeNeedsRefereeAutopilot(mode) {
  return mode === PAPER_BATCH_MODES.REFEREE_AUTOPILOT;
}

function modeNeedsJournalManage(mode) {
  return mode === PAPER_BATCH_MODES.JOURNAL_MANAGE;
}

function modeNeedsEmpiricalAnalysis(mode) {
  return mode === PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS;
}

function modeNeedsVenueResolve(mode) {
  return mode === PAPER_BATCH_MODES.VENUE_RESOLVE;
}

function modeNeedsSourceAdapt(mode) {
  return mode === PAPER_BATCH_MODES.SOURCE_ADAPT;
}

function modeNeedsSubmission(mode) {
  return [
    PAPER_BATCH_MODES.LOCAL_DRY_RUN,
    PAPER_BATCH_MODES.REVIEWED_SUBMIT,
  ].includes(mode);
}

function stateWithAdapterResults(row, { buildResult, packageResult, researchReport, refereeRevision, lifecycle } = {}) {
  const artifactPackage = packageResult?.artifactPackage || null;
  const hasCompiledPdf = (artifactPackage?.artifacts || []).some((artifact) => artifact.role === 'compiled_pdf');
  const submissionIntent = row.submissionIntent || row.task.registry?.submissionIntent || {
    status: 'submission_candidate',
    disposition: 'active_submission',
    reason: 'default_submission_candidate',
  };
  const compileStatus = buildResult?.status === 'build_passed'
    ? 'build_passed'
    : hasCompiledPdf
      ? 'compiled_pdf_present'
    : row.state.compileStatus;
  const researchVerifyStatus = ['evidence_present', 'proposal_seed_present'].includes(researchReport?.status)
    ? researchReport.status
    : row.state.researchVerifyStatus;
  const packageStatus = artifactPackage?.packageStatus || row.state.packageStatus;
  const runnerStatus = lifecycle?.receipt?.status === 'dry_run_recorded'
    ? 'dry_run_receipt_recorded'
    : row.state.runnerStatus;
  const submissionStatus = lifecycle?.venueStateProof?.status === 'dry_run_state_proof'
    ? 'venue_state_proof_recorded'
    : row.state.submissionStatus;
  const rawBlockers = [
    ...(row.state.blockers || []),
    ...(buildResult?.blockers || []),
    ...(packageResult?.blockers || []),
    ...(researchReport?.blockers || []),
    ...(refereeRevision?.blockers || []),
    ...(lifecycle?.venuePlan?.blockers || []),
    ...(lifecycle?.manifest?.blockers || []),
  ];
  let blockers = rawBlockers;
  let forcedNextAction = null;
  let forcedAutoLevel = null;
  let forcedReadinessStatus = null;
  if (submissionIntent.status === 'needs_venue_decision') {
    blockers = rawBlockers.filter((blocker) => !['venue_target_missing', 'venue_submission_plan_not_ready'].includes(blocker));
    const packageNotSubmitReady = artifactPackage && !artifactPackage.submitReady;
    forcedReadinessStatus = blockers.length || packageNotSubmitReady
      ? 'needs_local_package_before_venue_decision'
      : 'needs_venue_decision';
    forcedNextAction = 'paper.venue.resolve';
    forcedAutoLevel = 'manual_venue_decision';
  } else if (submissionIntent.status === 'source_adapt_required') {
    blockers = [];
    forcedReadinessStatus = 'source_adapt_required';
    forcedNextAction = 'paper.source.adapt';
    forcedAutoLevel = 'manual_source_adapt';
  } else if (submissionIntent.status === 'non_submission_archive') {
    blockers = [];
    forcedReadinessStatus = 'non_submission_archive';
    forcedNextAction = 'paper.archive.non_submission';
    forcedAutoLevel = 'non_submission_archive';
  }
  const warnings = [
    ...(row.state.warnings || []),
    ...(buildResult?.warnings || []),
    ...(packageResult?.warnings || []),
    ...(researchReport?.warnings || []),
    ...(refereeRevision?.warnings || []),
    ...(lifecycle?.venuePlan?.warnings || []),
    ...(lifecycle?.manifest?.warnings || []),
  ];
  const readinessStatus = forcedReadinessStatus || (blockers.length
    ? 'blocked'
    : ['package_present', 'package_ready'].includes(packageStatus)
      ? 'ready_for_local_dry_run'
      : row.state.readinessStatus);
  let state = createPaperWorkflowState({
    paperTask: row.task,
    draftStatus: row.state.draftStatus,
    compileStatus,
    researchVerifyStatus,
    packageStatus,
    readinessStatus,
    runnerStatus,
    submissionStatus,
    blockers,
    warnings,
    submissionIntent,
    evidenceRefs: [
      ...(row.state.evidenceRefs || []),
      ...(artifactPackage?.evidenceRefs || []),
    ],
  });
  state = {
    ...state,
    nextAction: forcedNextAction || nextActionForState(state),
    autoLevel: forcedAutoLevel || autoLevelForState(state),
  };
  return {
    ...state,
    stage: inferPaperStage(state),
  };
}

function makeMarkdownTable(rows) {
  const headers = [
    'paper_id',
    'venue',
    'draft_status',
    'compile_status',
    'research_verify_status',
    'package_status',
    'readiness_status',
    'runner_status',
    'submission_status',
    'next_action',
    'auto_level',
    'submission_intent',
    'production_disposition',
  ];
  const escapeCell = (value) => String(value ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${headers.map((header) => escapeCell(row[header])).join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}

function summarizeRows(rows, mode) {
  return {
    mode,
    total: rows.length,
    sourceReady: rows.filter((row) => row.draft_status === 'source_tex_present').length,
    buildReady: rows.filter((row) => ['compiled_pdf_present', 'build_ready', 'build_passed'].includes(row.compile_status)).length,
    researchReady: rows.filter((row) => ['verified', 'evidence_present', 'proposal_seed_present', 'manual_review_only'].includes(row.research_verify_status)).length,
    packageReady: rows.filter((row) => ['package_present', 'package_ready'].includes(row.package_status)).length,
    localDryRunReady: rows.filter((row) => row.readiness_status === 'ready_for_local_dry_run').length,
    dryRunReceipts: rows.filter((row) => row.runner_status === 'dry_run_receipt_recorded').length,
    reviewedSubmitBlocked: rows.filter((row) => row.next_action === PAPER_ACTIONS.REVIEWED_SUBMIT).length,
    blocked: rows.filter((row) => row.readiness_status === 'blocked').length,
    activeSubmissionCandidates: rows.filter((row) => row.production_disposition === 'active_submission').length,
    needsVenueDecision: rows.filter((row) => row.submission_intent === 'needs_venue_decision').length,
    needsSourceAdapt: rows.filter((row) => row.submission_intent === 'source_adapt_required').length,
    nonSubmissionArchive: rows.filter((row) => row.submission_intent === 'non_submission_archive').length,
  };
}

function summarizeResults(results, legacyCleanupAudit = null) {
  const proposalStaging = {
    staged: results.filter((result) => result.task?.registry?.inventorySource === 'proposal_staging').length,
    sourceSkeletons: results.filter((result) => (
      result.task?.registry?.inventorySource === 'proposal_staging'
      && normalizeText(result.task?.sourceWorkspace).includes('/runtime/proposals/')
    )).length,
  };
  const buildArtifactAcceptance = {
    accepted: results.filter((result) => (
      result.buildResult?.buildArtifactAcceptance?.status === 'compiled_pdf_accepted_for_local_package'
      || (result.packageResult?.artifactPackage?.artifacts || []).some((artifact) => artifact.role === 'build_artifact_acceptance')
    )).length,
    compiledPdfArtifacts: results.filter((result) => (
      (result.packageResult?.artifactPackage?.artifacts || []).some((artifact) => artifact.role === 'compiled_pdf')
    )).length,
  };
  const researchTypedContracts = results.reduce((count, result) => (
    count + (result.researchReport?.typedContracts ? 1 : 0)
  ), 0);
  const researchWorkerReceipts = results.reduce((count, result) => (
    count + Number(result.researchReport?.workerReceiptCount || 0)
  ), 0);
  const researchWorkerCatalogSize = Math.max(0, ...results.map((result) => (
    Number(result.researchReport?.researchWorkerCount || 0)
  )));
  const journalManageReports = results.filter((result) => (
    result.journalManagement?.kind === 'JournalManageAdapterReport'
  )).length;
  const journalConferenceRegistries = results.filter((result) => (
    result.journalManagement?.registry?.kind === 'JournalConferenceRegistry'
    || result.refereeAutopilot?.journalConferenceRegistry?.kind === 'JournalConferenceRegistry'
  )).length;
  const targetSelectionPolicies = results.filter((result) => (
    result.journalManagement?.targetSelectionPolicy?.kind === 'TargetSelectionPolicy'
    || result.refereeAutopilot?.targetSelectionPolicy?.kind === 'TargetSelectionPolicy'
  )).length;
  const journalTargetProfiles = results.filter((result) => (
    result.journalManagement?.targetProfile?.kind === 'JournalTargetProfile'
    || result.refereeAutopilot?.targetJournalProfile?.kind === 'JournalTargetProfile'
  )).length;
  const journalTargetProfileReady = results.filter((result) => (
    result.journalManagement?.targetProfile?.status === 'journal_target_profile_ready'
    || result.refereeAutopilot?.targetJournalProfile?.status === 'journal_target_profile_ready'
  )).length;
  const journalRubricPackets = results.filter((result) => (
    result.journalManagement?.rubricPacket?.kind === 'JournalRubricPacket'
    || result.refereeAutopilot?.finalJournalRubricPacket?.kind === 'JournalRubricPacket'
  )).length;
  const journalRubricReady = results.filter((result) => (
    result.journalManagement?.rubricPacket?.status === 'journal_rubric_packet_ready'
    || result.refereeAutopilot?.finalJournalRubricPacket?.status === 'journal_rubric_packet_ready'
  )).length;
  const venueRubricManagers = results.filter((result) => (
    result.journalManagement?.venueRubricManager?.kind === 'VenueRubricManager'
    || result.refereeAutopilot?.finalVenueRubricManager?.kind === 'VenueRubricManager'
  )).length;
  const freshRefereePools = results.filter((result) => (
    result.journalManagement?.freshRefereePool?.kind === 'FreshRefereePool'
    || result.refereeAutopilot?.finalFreshRefereePool?.kind === 'FreshRefereePool'
  )).length;
  const venueEvidenceGates = results.filter((result) => (
    result.journalManagement?.evidenceGate?.kind === 'VenueEvidenceGate'
    || result.refereeAutopilot?.finalVenueEvidenceGate?.kind === 'VenueEvidenceGate'
  )).length;
  const venueEvidenceGateReady = results.filter((result) => (
    result.journalManagement?.evidenceGate?.status === 'venue_evidence_gate_ready'
    || result.refereeAutopilot?.finalVenueEvidenceGate?.status === 'venue_evidence_gate_ready'
  )).length;
  const venueLifecyclePolicies = results.filter((result) => (
    result.journalManagement?.lifecyclePolicy?.kind === 'VenueLifecyclePolicy'
    || result.refereeAutopilot?.finalVenueLifecyclePolicy?.kind === 'VenueLifecyclePolicy'
  )).length;
  const journalConferenceSystemPackets = results.filter((result) => (
    result.journalManagement?.systemPacket?.kind === 'JournalConferenceSystemPacket'
    || result.refereeAutopilot?.journalConferenceSystemPacket?.kind === 'JournalConferenceSystemPacket'
  )).length;
  const empiricalAnalysisReports = results.filter((result) => (
    result.empiricalAnalysis?.kind === 'EmpiricalAnalysisAdapterReport'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.kind === 'EmpiricalAnalysisAdapterReport'
  )).length;
  const empiricalAnalysisEvidenceReady = results.filter((result) => (
    result.empiricalAnalysis?.status === 'empirical_analysis_evidence_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.status === 'empirical_analysis_evidence_ready'
  )).length;
  const empiricalBenchmarkRegistries = results.filter((result) => (
    result.empiricalAnalysis?.empiricalBenchmarkRegistry?.kind === 'EmpiricalBenchmarkRegistry'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.empiricalBenchmarkRegistry?.kind === 'EmpiricalBenchmarkRegistry'
  )).length;
  const empiricalBenchmarkRegistriesReady = results.filter((result) => (
    result.empiricalAnalysis?.empiricalBenchmarkRegistry?.status === 'empirical_benchmark_registry_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.empiricalBenchmarkRegistry?.status === 'empirical_benchmark_registry_ready'
  )).length;
  const benchmarkSuiteSelectionPolicies = results.filter((result) => (
    result.empiricalAnalysis?.benchmarkSuiteSelectionPolicy?.kind === 'BenchmarkSuiteSelectionPolicy'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.benchmarkSuiteSelectionPolicy?.kind === 'BenchmarkSuiteSelectionPolicy'
  )).length;
  const benchmarkSuiteSelectionReady = results.filter((result) => (
    result.empiricalAnalysis?.benchmarkSuiteSelectionPolicy?.status === 'benchmark_suite_selection_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.benchmarkSuiteSelectionPolicy?.status === 'benchmark_suite_selection_ready'
  )).length;
  const empiricalLocalBenchmarkRegistries = results.filter((result) => (
    result.empiricalAnalysis?.localBenchmarkRegistry?.kind === 'LocalBenchmarkRegistry'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.localBenchmarkRegistry?.kind === 'LocalBenchmarkRegistry'
  )).length;
  const empiricalLocalBenchmarkRegistryReady = results.filter((result) => (
    result.empiricalAnalysis?.localBenchmarkRegistry?.status === 'local_benchmark_registry_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.localBenchmarkRegistry?.status === 'local_benchmark_registry_ready'
  )).length;
  const empiricalAuthorizedLocalDatasets = results.filter((result) => (
    result.empiricalAnalysis?.datasetAccessContract?.datasetMode === 'authorized_local_dataset'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.datasetAccessContract?.datasetMode === 'authorized_local_dataset'
  )).length;
  const datasetLicenseProvenanceGates = results.filter((result) => (
    result.empiricalAnalysis?.datasetLicenseProvenanceGate?.kind === 'DatasetLicenseProvenanceGate'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.datasetLicenseProvenanceGate?.kind === 'DatasetLicenseProvenanceGate'
  )).length;
  const datasetLicenseProvenanceGateReady = results.filter((result) => (
    result.empiricalAnalysis?.datasetLicenseProvenanceGate?.status === 'dataset_license_provenance_gate_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.datasetLicenseProvenanceGate?.status === 'dataset_license_provenance_gate_ready'
  )).length;
  const tableFigureSpecs = results.filter((result) => (
    result.empiricalAnalysis?.tableFigureSpec?.kind === 'TableFigureSpec'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.tableFigureSpec?.kind === 'TableFigureSpec'
  )).length;
  const tableFigureSpecReady = results.filter((result) => (
    result.empiricalAnalysis?.tableFigureSpec?.status === 'table_figure_spec_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.tableFigureSpec?.status === 'table_figure_spec_ready'
  )).length;
  const empiricalExperimentRunReceipts = results.filter((result) => (
    result.empiricalAnalysis?.experimentRunReceipt?.kind === 'ExperimentRunReceipt'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.experimentRunReceipt?.kind === 'ExperimentRunReceipt'
  )).length;
  const empiricalExperimentRunRecorded = results.filter((result) => (
    result.empiricalAnalysis?.experimentRunReceipt?.status === 'experiment_run_receipt_recorded'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.experimentRunReceipt?.status === 'experiment_run_receipt_recorded'
  )).length;
  const empiricalResultArtifactPackages = results.filter((result) => (
    result.empiricalAnalysis?.resultArtifactPackage?.kind === 'ResultArtifactPackage'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.resultArtifactPackage?.kind === 'ResultArtifactPackage'
  )).length;
  const empiricalEvidenceGates = results.filter((result) => (
    result.empiricalAnalysis?.empiricalEvidenceGate?.kind === 'EmpiricalEvidenceGate'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.empiricalEvidenceGate?.kind === 'EmpiricalEvidenceGate'
  )).length;
  const empiricalEvidenceGateReady = results.filter((result) => (
    result.empiricalAnalysis?.empiricalEvidenceGate?.status === 'empirical_evidence_gate_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.empiricalEvidenceGate?.status === 'empirical_evidence_gate_ready'
  )).length;
  const empiricalManuscriptPatches = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalPatch?.kind === 'ManuscriptEmpiricalPatch'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.manuscriptEmpiricalPatch?.kind === 'ManuscriptEmpiricalPatch'
  )).length;
  const empiricalManuscriptPatchReady = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalPatch?.status === 'manuscript_empirical_patch_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.manuscriptEmpiricalPatch?.status === 'manuscript_empirical_patch_ready'
  )).length;
  const empiricalManuscriptApplyApprovalPackets = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.kind === 'ManuscriptEmpiricalApplyApprovalPacket'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.kind === 'ManuscriptEmpiricalApplyApprovalPacket'
  )).length;
  const empiricalManuscriptApplyApprovalReady = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.status === 'manuscript_empirical_apply_approval_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.status === 'manuscript_empirical_apply_approval_ready'
  )).length;
  const empiricalManuscriptApplyPlans = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyPlan?.kind === 'ManuscriptEmpiricalApplyPlan'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyPlan?.kind === 'ManuscriptEmpiricalApplyPlan'
  )).length;
  const empiricalManuscriptApplyPlanReady = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyPlan?.status === 'manuscript_empirical_apply_plan_ready'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyPlan?.status === 'manuscript_empirical_apply_plan_ready'
  )).length;
  const empiricalManuscriptApplyReceipts = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.kind === 'ManuscriptEmpiricalApplyReceipt'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.kind === 'ManuscriptEmpiricalApplyReceipt'
  )).length;
  const empiricalManuscriptApplyApplied = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied'
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied'
  )).length;
  const empiricalExternalActions = results.filter((result) => (
    result.empiricalAnalysis?.safety?.externalActionPerformed === true
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.safety?.externalActionPerformed === true
  )).length;
  const empiricalSourceMutations = results.filter((result) => (
    result.empiricalAnalysis?.safety?.sourceMutation === true
    || result.refereeAutopilot?.finalEmpiricalAnalysis?.safety?.sourceMutation === true
  )).length;
  const freshRefereeVerdicts = results.reduce((sum, result) => (
    sum + Number(result.refereeAutopilot?.freshRefereeVerdictCount || 0)
  ), 0);
  const freshRefereeAccepts = results.reduce((sum, result) => (
    sum + Number(result.refereeAutopilot?.freshRefereeAcceptCount || 0)
  ), 0);
  const freshRefereeRevisions = results.reduce((sum, result) => (
    sum + Number(result.refereeAutopilot?.freshRefereeReviseCount || 0)
  ), 0);
  const refereeOpenIssues = results.reduce((count, result) => (
    count + Number(result.refereeRevision?.openIssueCount || 0)
  ), 0);
  const refereeReviewReports = results.filter((result) => (
    result.refereeReview?.reviewReport?.kind === 'AgentRefereeReviewReport'
  )).length;
  const refereeReviewReady = results.filter((result) => (
    result.refereeReview?.reviewReport?.status === 'agent_referee_review_ready'
  )).length;
  const refereeReviewBlocked = results.filter((result) => (
    result.refereeReview?.reviewReport?.status === 'agent_referee_review_blocked'
    || result.refereeReview?.intake?.status === 'referee_review_intake_blocked'
  )).length;
  const refereeReviewFindings = results.reduce((count, result) => (
    count + Number(result.refereeReview?.findingCount || 0)
  ), 0);
  const refereeIssueQueueMaterializations = results.filter((result) => (
    result.refereeReview?.materialization?.kind === 'RefereeIssueQueueMaterialization'
  )).length;
  const refereeIssueQueueMaterializationPlanned = results.filter((result) => (
    result.refereeReview?.materialization?.status === 'referee_issue_queue_materialization_planned'
  )).length;
  const refereeIssueQueueMaterialized = results.filter((result) => (
    result.refereeReview?.materialization?.status === 'referee_issue_queue_materialized'
  )).length;
  const refereeIssueQueueMaterializationBlocked = results.filter((result) => (
    result.refereeReview?.materialization?.status === 'referee_issue_queue_materialization_blocked'
  )).length;
  const refereeReviewIssueRowsInserted = results.reduce((count, result) => (
    count + Number(result.refereeReview?.materializedIssueCount || 0)
  ), 0);
  const refereeReviewIssueRowsAlreadyPresent = results.reduce((count, result) => (
    count + Number(result.refereeReview?.existingIssueCount || 0)
  ), 0);
  const refereePreflightReady = results.filter((result) => (
    result.refereeRevision?.patchExecutionPreflight?.status === 'dry_run_patch_execution_preflight_ready'
  )).length;
  const refereeRollbackLedgerDrafts = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.rollbackLedgerDraft?.status === 'rollback_ledger_draft_ready'
  )).length;
  const refereePreimageSnapshotLedgers = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.preimageSnapshotLedger?.kind === 'RefereeRevisionPreimageSnapshotLedger'
  )).length;
  const refereePreimageSnapshotReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.preimageSnapshotLedger?.status === 'preimage_snapshot_ready'
  )).length;
  const refereeExecutePlansReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executePlan?.status === 'execute_plan_ready_requires_explicit_apply_mode'
  )).length;
  const refereeApplyModeContracts = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyModeContract?.kind === 'RefereeRevisionApplyModeContract'
  )).length;
  const refereeExecuteDesignPackets = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executeDesignPacket?.kind === 'RefereeRevisionExecuteDesignPacket'
  )).length;
  const refereeExecuteDesignReadyApplyBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executeDesignPacket?.status === 'referee_execute_design_ready_apply_blocked'
  )).length;
  const refereeExecuteDesignReadyForApplyExecution = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executeDesignPacket?.status === 'referee_execute_design_ready_for_apply_execution'
  )).length;
  const refereeApplyApprovalPackets = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.kind === 'RefereeApplyApprovalPacket'
  )).length;
  const refereeApplyApprovalBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.status === 'referee_apply_approval_blocked'
  )).length;
  const refereeApplyApprovalReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.status === 'referee_apply_approval_ready_for_patch_execution'
  )).length;
  const refereeApplyAgentApproved = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.approvalActor === 'agent'
    && result.refereeRevision?.applyApprovalPacket?.approved === true
  )).length;
  const refereePatchApplyExecutions = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyExecution?.kind === 'RefereePatchApplyExecution'
  )).length;
  const refereePatchApplyExecutionBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyExecution?.status === 'referee_patch_apply_execution_blocked'
  )).length;
  const refereePatchApplyExecutionReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyExecution?.status === 'referee_patch_apply_ready_for_separate_executor'
  )).length;
  const refereePatchApplyApprovalGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.patchApplyExecution?.blockers || []).includes('referee_apply_approval_not_ready')
  )).length;
  const refereePatchApplyInvocations = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.kind === 'RefereePatchApplyInvocation'
  )).length;
  const refereePatchApplyInvocationBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.status === 'referee_patch_apply_invocation_blocked'
  )).length;
  const refereePatchApplyInvocationRequired = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.patchApplyInvocation?.blockers || []).includes('explicit_referee_patch_apply_execute_invocation_required')
  )).length;
  const refereePatchApplyValidationBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && Number(result.refereeRevision?.patchApplyInvocation?.validationRecordCount || 0) > 0
    && (result.refereeRevision?.patchApplyInvocation?.blockers || []).some((blocker) => (
      blocker.includes('patch_file')
      || blocker.includes('patch_hash')
      || blocker.includes('patch_path')
      || blocker.includes('patch_target')
      || blocker.includes('preimage_')
      || blocker.includes('combined_patch')
      || blocker.includes('git_apply')
    ))
  )).length;
  const refereePatchApplyInvocationApplied = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.status === 'referee_patch_apply_invocation_applied'
  )).length;
  const refereeAgentRepairPatchBundles = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.kind === 'RefereeAgentRepairPatchBundle'
  )).length;
  const refereeAgentRepairPatchBundleReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.status === 'agent_repair_patch_bundle_ready'
  )).length;
  const refereeAgentRepairPatchBundleAlreadyPresent = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.status === 'agent_repair_patch_already_present'
  )).length;
  const refereeAgentRepairPatchBundleBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.status === 'agent_repair_patch_bundle_blocked'
  )).length;
  const refereeSourceMutations = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.safety?.sourceMutation === true
  )).length;
  const refereeAppliedPatchReceipts = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.appliedPatchReceipt?.kind === 'RefereeAppliedPatchReceipt'
  )).length;
  const refereeAppliedPatchReceiptBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.appliedPatchReceipt?.status === 'applied_patch_receipt_blocked'
  )).length;
  const refereeAppliedPatchReceiptRecorded = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.appliedPatchReceipt?.status === 'applied_patch_receipt_recorded'
  )).length;
  const refereeAppliedPatchExecutionGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.appliedPatchReceipt?.blockers || []).includes('referee_patch_apply_execution_not_ready')
  )).length;
  const refereeAppliedPatchInvocationGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.appliedPatchReceipt?.blockers || []).includes('referee_patch_apply_invocation_not_applied')
  )).length;
  const refereePostRepairBuildPackages = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairBuildPackage?.kind === 'PostRepairBuildPackage'
  )).length;
  const refereePostRepairBuildPackageBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairBuildPackage?.status === 'post_repair_build_package_blocked'
  )).length;
  const refereePostRepairBuildPackageReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairBuildPackage?.status === 'post_repair_build_package_ready'
  )).length;
  const refereePostRepairBuildRecheckPassed = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairRechecks?.buildRecheck?.status === 'build_recheck_passed'
  )).length;
  const refereePostRepairPackageRewriteReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairRechecks?.packageRecheck?.status === 'package_rewrite_ready'
  )).length;
  const refereePostRepairResearchRecheckPassed = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairRechecks?.researchRecheck?.status === 'research_recheck_passed'
  )).length;
  const refereePostRepairAppliedReceiptGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.postRepairBuildPackage?.blockers || []).includes('applied_patch_receipt_not_recorded')
  )).length;
  const refereeIssueResolutionProofs = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.issueResolutionProof?.kind === 'RefereeIssueResolutionProof'
  )).length;
  const refereeIssueResolutionProofBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.issueResolutionProof?.status === 'referee_issue_resolution_proof_blocked'
  )).length;
  const refereeIssueResolutionProofReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.issueResolutionProof?.status === 'referee_issue_resolution_proof_ready'
  )).length;
  const refereeIssueResolutionEvidenceItems = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.issueResolutionProof?.resolutionEvidenceCount || 0)
  ), 0);
  const refereeIssueResolutionPostRepairGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.issueResolutionProof?.blockers || []).includes('post_repair_build_package_not_ready')
  )).length;
  const refereeRepairReconciliations = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.kind === 'RepairReconciliation'
  )).length;
  const refereeRepairReconciliationBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.status === 'repair_reconciliation_blocked'
  )).length;
  const refereeRepairReconciliationReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.status === 'repair_reconciliation_ready'
  )).length;
  const refereeRepairReconciled = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.repairReconciled === true
  )).length;
  const refereeRepairStateMutationReceipts = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.kind === 'RepairStateMutationReceipt'
  )).length;
  const refereeRepairStateMutationRecorded = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.status === 'repair_state_mutation_recorded'
  )).length;
  const refereeRepairStateMutationBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.status === 'repair_state_mutation_blocked'
  )).length;
  const refereeRepairStateMutationIssueRowsUpdated = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.issueRowsUpdated || 0)
  ), 0);
  const refereeRepairStateMutationPatchRowsInserted = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.patchRowsInserted || 0)
  ), 0);
  const refereeRepairStateMutationPatchRowsUpdated = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.patchRowsUpdated || 0)
  ), 0);
  const refereeRepairStateMutationPatchRowsAlreadyPresent = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.patchRowsAlreadyPresent || 0)
  ), 0);
  const refereeReviewedSubmitReadinessReleased = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.reviewedSubmitReadinessReleased === true
  )).length;
  const refereeIssueStateMutations = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.issueStateMutationPerformed === true
  )).length;
  const refereeSqliteWrites = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.safety?.writesSqlite === true
  )).length;
  const refereeRepairReconciliationProofGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.repairReconciliation?.blockers || []).includes('referee_issue_resolution_proof_not_ready')
  )).length;
  const refereeApplyApprovalRequired = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (
      (result.refereeRevision?.applyModeContract?.blockers || []).includes('agent_referee_apply_approval_required')
      || (result.refereeRevision?.applyApprovalPacket?.blockers || []).includes('agent_referee_apply_approval_required')
    )
  )).length;
  const lifecycleReconciled = results.filter((result) => result.lifecycle?.reconciliation?.status === 'dry_run_reconciled').length;
  const lifecycleOutboxItems = results.filter((result) => result.lifecycle?.outbox?.kind === 'ExternalExecutorHandoffOutbox').length;
  const lifecycles = results.map((result) => result.lifecycle).filter(Boolean);
  const reviewedSubmitLifecycles = lifecycles.filter((lifecycle) => lifecycle.reviewedSubmit);
  const submissionPreflight = {
    lifecycleItems: lifecycles.length,
    reviewedSubmitItems: reviewedSubmitLifecycles.length,
    approvalPackets: reviewedSubmitLifecycles.filter((lifecycle) => lifecycle.approvalPacket?.kind === 'SubmissionApprovalPacket').length,
    approvalRequired: reviewedSubmitLifecycles.filter((lifecycle) => (
      (lifecycle.approvalPacket?.blockers || []).includes('explicit_reviewed_submit_approval_required')
    )).length,
    approvalAgentApproved: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.approvalPacket?.agentApproved === true
    )).length,
    reviewedSubmitPreflightPackets: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.reviewedSubmitPreflightPacket?.kind === 'ReviewedSubmitPreflightPacket'
    )).length,
    reviewedSubmitPreflightBlocked: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.reviewedSubmitPreflightPacket?.status === 'reviewed_submit_preflight_blocked'
    )).length,
    reviewedSubmitPreflightReady: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.reviewedSubmitPreflightPacket?.status === 'reviewed_submit_preflight_ready_for_external_executor'
    )).length,
    freshVenueEvidenceReady: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.freshVenueEvidenceBundle?.status === 'fresh_venue_evidence_ready'
    )).length,
    executorOutboxItems: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.outbox?.kind === 'ExternalExecutorHandoffOutbox'
    )).length,
    executorOutboxBlocked: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.outbox?.status === 'blocked_outbox_item'
    )).length,
    controlledExecutorReceipts: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.controlledExecutorReceipt?.kind === 'ControlledExternalExecutorReceipt'
    )).length,
    controlledExecutorReceiptRecorded: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.controlledExecutorReceipt?.status === 'controlled_external_executor_receipt_recorded'
    )).length,
    controlledExecutorReceiptBlocked: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.controlledExecutorReceipt?.status === 'controlled_external_executor_blocked'
    )).length,
    liveExecutorBoundaryBlocked: reviewedSubmitLifecycles.filter((lifecycle) => (
      (lifecycle.manifest?.blockers || []).includes('live_submit_not_implemented_in_overlay')
    )).length,
    externalActionsPerformed: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.receipt?.externalActionPerformed || lifecycle.safety?.externalActionPerformed
    )).length,
  };
  const refereeAutopilotRuns = results.filter((result) => (
    result.refereeAutopilot?.kind === 'RefereeAutopilotReport'
  )).length;
  const refereeAutopilotAccepted = results.filter((result) => (
    result.refereeAutopilot?.accepted === true
  )).length;
  const refereeAutopilotBlocked = results.filter((result) => (
    result.refereeAutopilot?.status === 'referee_autopilot_blocked'
  )).length;
  const refereeAutopilotRounds = results.reduce((sum, result) => (
    sum + Number(result.refereeAutopilot?.roundsCompleted || 0)
  ), 0);
  const refereeAutopilotFinalOpenIssues = results.reduce((sum, result) => (
    sum + Number(result.refereeAutopilot?.finalOpenIssueCount || 0)
  ), 0);
  const refereeAutopilotSourceMutations = results.reduce((sum, result) => (
    sum + Number(result.refereeAutopilot?.sourceMutationCount || 0)
  ), 0);
  const refereeAutopilotSqliteWrites = results.reduce((sum, result) => (
    sum + Number(result.refereeAutopilot?.sqliteWriteCount || 0)
  ), 0);
  const refereeAutopilotAcceptanceReceipts = results.filter((result) => (
    result.refereeAutopilot?.acceptanceReceipt?.kind === 'RefereeAutopilotAcceptanceReceipt'
  )).length;
  const refereeAutopilotAcceptanceRecorded = results.filter((result) => (
    result.refereeAutopilot?.acceptanceReceipt?.status === 'referee_autopilot_accept_recorded'
  )).length;
  const refereeAutopilotExternalActions = results.filter((result) => (
    result.refereeAutopilot?.safety?.externalActionPerformed === true
  )).length;
  const venueResolution = {
    required: results.filter((result) => result.venueResolution?.venueResolutionRequired).length,
    packets: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.packet?.kind === 'VenueResolutionPacket'
    )).length,
    manualDecisionRequired: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.packet?.status === 'manual_venue_decision_required'
    )).length,
    waitingForLocalPackage: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.packet?.status === 'venue_resolution_waiting_for_local_package'
    )).length,
    withCandidateVenues: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && Number(result.venueResolution?.candidateCount || 0) > 0
    )).length,
    submitReadyPackagePlansRequired: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.submitReadyPackagePlan?.status === 'submit_ready_package_plan_required'
    )).length,
    registryAddPlansReady: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.venueRegistryAddPlan?.status === 'registry_add_plan_requires_operator_target'
    )).length,
    operatorPacketsReady: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.venueResolutionOperatorPacket?.status === 'venue_operator_decision_ready'
    )).length,
    operatorPacketsBlocked: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.venueResolutionOperatorPacket?.status === 'venue_operator_packet_blocked'
    )).length,
  };
  const sourceAdaptation = {
    required: results.filter((result) => result.sourceAdaptation?.sourceAdaptationRequired).length,
    packets: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.packet?.kind === 'SourceAdaptationPacket'
    )).length,
    manualSourceDecisionRequired: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.packet?.status === 'manual_source_decision_required'
    )).length,
    mainTexCandidateReviewRequired: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.packet?.status === 'main_tex_candidate_review_required'
    )).length,
    withTexCandidates: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && Number(result.sourceAdaptation?.packet?.texCandidateCount || 0) > 0
    )).length,
    pdfOnlyOrCodeProject: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && Number(result.sourceAdaptation?.packet?.pdfCandidateCount || 0) > 0
      && Number(result.sourceAdaptation?.packet?.texCandidateCount || 0) === 0
    )).length,
    operatorPacketsReady: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && ['main_tex_selection_ready', 'source_material_decision_ready'].includes(
        result.sourceAdaptation?.sourceAdaptationOperatorPacket?.status,
      )
    )).length,
    operatorPacketsBlocked: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.sourceAdaptationOperatorPacket?.status === 'source_operator_packet_blocked'
    )).length,
  };
  return {
    proposalStaging,
    buildArtifactAcceptance,
    researchTypedContracts,
    researchWorkerReceipts,
    researchWorkerCatalogSize,
    journalManageReports,
    journalConferenceRegistries,
    targetSelectionPolicies,
    journalTargetProfiles,
    journalTargetProfileReady,
    journalRubricPackets,
    journalRubricReady,
    venueRubricManagers,
    freshRefereePools,
    venueEvidenceGates,
    venueEvidenceGateReady,
    venueLifecyclePolicies,
    journalConferenceSystemPackets,
    empiricalAnalysisReports,
    empiricalAnalysisEvidenceReady,
    empiricalBenchmarkRegistries,
    empiricalBenchmarkRegistriesReady,
    benchmarkSuiteSelectionPolicies,
    benchmarkSuiteSelectionReady,
    empiricalLocalBenchmarkRegistries,
    empiricalLocalBenchmarkRegistryReady,
    empiricalAuthorizedLocalDatasets,
    datasetLicenseProvenanceGates,
    datasetLicenseProvenanceGateReady,
    tableFigureSpecs,
    tableFigureSpecReady,
    empiricalExperimentRunReceipts,
    empiricalExperimentRunRecorded,
    empiricalResultArtifactPackages,
    empiricalEvidenceGates,
    empiricalEvidenceGateReady,
    empiricalManuscriptPatches,
    empiricalManuscriptPatchReady,
    empiricalManuscriptApplyApprovalPackets,
    empiricalManuscriptApplyApprovalReady,
    empiricalManuscriptApplyPlans,
    empiricalManuscriptApplyPlanReady,
    empiricalManuscriptApplyReceipts,
    empiricalManuscriptApplyApplied,
    empiricalExternalActions,
    empiricalSourceMutations,
    freshRefereeVerdicts,
    freshRefereeAccepts,
    freshRefereeRevisions,
    refereeReviewReports,
    refereeReviewReady,
    refereeReviewBlocked,
    refereeReviewFindings,
    refereeIssueQueueMaterializations,
    refereeIssueQueueMaterializationPlanned,
    refereeIssueQueueMaterialized,
    refereeIssueQueueMaterializationBlocked,
    refereeReviewIssueRowsInserted,
    refereeReviewIssueRowsAlreadyPresent,
    refereeOpenIssues,
    refereePreflightReady,
    refereeRollbackLedgerDrafts,
    refereePreimageSnapshotLedgers,
    refereePreimageSnapshotReady,
    refereeExecutePlansReady,
    refereeApplyModeContracts,
    refereeExecuteDesignPackets,
    refereeExecuteDesignReadyApplyBlocked,
    refereeExecuteDesignReadyForApplyExecution,
    refereeApplyApprovalPackets,
    refereeApplyApprovalBlocked,
    refereeApplyApprovalReady,
    refereeApplyAgentApproved,
    refereePatchApplyExecutions,
    refereePatchApplyExecutionBlocked,
    refereePatchApplyExecutionReady,
    refereePatchApplyApprovalGateBlocked,
    refereePatchApplyInvocations,
    refereePatchApplyInvocationBlocked,
    refereePatchApplyInvocationRequired,
    refereePatchApplyValidationBlocked,
    refereePatchApplyInvocationApplied,
    refereeAgentRepairPatchBundles,
    refereeAgentRepairPatchBundleReady,
    refereeAgentRepairPatchBundleAlreadyPresent,
    refereeAgentRepairPatchBundleBlocked,
    refereeSourceMutations,
    refereeAppliedPatchReceipts,
    refereeAppliedPatchReceiptBlocked,
    refereeAppliedPatchReceiptRecorded,
    refereeAppliedPatchExecutionGateBlocked,
    refereeAppliedPatchInvocationGateBlocked,
    refereePostRepairBuildPackages,
    refereePostRepairBuildPackageBlocked,
    refereePostRepairBuildPackageReady,
    refereePostRepairBuildRecheckPassed,
    refereePostRepairPackageRewriteReady,
    refereePostRepairResearchRecheckPassed,
    refereePostRepairAppliedReceiptGateBlocked,
    refereeIssueResolutionProofs,
    refereeIssueResolutionProofBlocked,
    refereeIssueResolutionProofReady,
    refereeIssueResolutionEvidenceItems,
    refereeIssueResolutionPostRepairGateBlocked,
    refereeRepairReconciliations,
    refereeRepairReconciliationBlocked,
    refereeRepairReconciliationReady,
    refereeRepairReconciled,
    refereeRepairStateMutationReceipts,
    refereeRepairStateMutationRecorded,
    refereeRepairStateMutationBlocked,
    refereeRepairStateMutationIssueRowsUpdated,
    refereeRepairStateMutationPatchRowsInserted,
    refereeRepairStateMutationPatchRowsUpdated,
    refereeRepairStateMutationPatchRowsAlreadyPresent,
    refereeReviewedSubmitReadinessReleased,
    refereeIssueStateMutations,
    refereeSqliteWrites,
    refereeRepairReconciliationProofGateBlocked,
    refereeApplyApprovalRequired,
    refereeAutopilotRuns,
    refereeAutopilotAccepted,
    refereeAutopilotBlocked,
    refereeAutopilotRounds,
    refereeAutopilotFinalOpenIssues,
    refereeAutopilotSourceMutations,
    refereeAutopilotSqliteWrites,
    refereeAutopilotAcceptanceReceipts,
    refereeAutopilotAcceptanceRecorded,
    refereeAutopilotExternalActions,
    lifecycleOutboxItems,
    lifecycleReconciled,
    submissionPreflight,
    venueResolution,
    sourceAdaptation,
    legacyCleanup: legacyCleanupAudit?.summary || null,
  };
}

function blockerFamilyFor(code) {
  const text = normalizeText(code).toLowerCase();
  if (/source|main_tex|tex/.test(text)) return 'source';
  if (/venue/.test(text)) return 'venue';
  if (/latex|compile|build/.test(text)) return 'build';
  if (/evidence|claim|proof|research|reproduc/.test(text)) return 'research_verify';
  if (/artifact|package|zip|pdf|checksum|sha256/.test(text)) return 'package';
  if (/runner|receipt|handoff|manifest|dry_run|replay/.test(text)) return 'runner_handoff';
  if (/approval|authorize|authorization|live_submit/.test(text)) return 'authorization';
  if (/submit|submission|portal|external/.test(text)) return 'submission';
  return 'other';
}

function blockerFamilySummary(results = []) {
  const families = {};
  for (const result of results) {
    const blockers = result.state?.blockers || [];
    const seenFamiliesForPaper = new Set();
    for (const blocker of blockers) {
      const family = blockerFamilyFor(blocker);
      if (!families[family]) {
        families[family] = {
          family,
          paperCount: 0,
          blockerCount: 0,
          blockers: {},
          paperIds: [],
        };
      }
      families[family].blockerCount += 1;
      families[family].blockers[blocker] = (families[family].blockers[blocker] || 0) + 1;
      if (!seenFamiliesForPaper.has(family)) {
        families[family].paperCount += 1;
        families[family].paperIds.push(result.paperId);
        seenFamiliesForPaper.add(family);
      }
    }
  }
  return Object.fromEntries(
    Object.values(families)
      .sort((left, right) => right.paperCount - left.paperCount || left.family.localeCompare(right.family))
      .map((item) => [item.family, {
        ...item,
        paperIds: item.paperIds.slice(0, 32),
        topBlockers: Object.entries(item.blockers)
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, 12)
          .map(([code, count]) => ({ code, count })),
      }]),
  );
}

function makeBlockerFamilyMarkdown(families = {}) {
  const values = Object.values(families);
  if (!values.length) return '| family | papers | blockers | top_blockers |\n| --- | --- | --- | --- |\n';
  const lines = ['| family | papers | blockers | top_blockers |', '| --- | --- | --- | --- |'];
  for (const family of values) {
    const top = (family.topBlockers || [])
      .map((item) => `${item.code}:${item.count}`)
      .join(', ');
    lines.push(`| ${family.family} | ${family.paperCount} | ${family.blockerCount} | ${top.replace(/\|/g, '/')} |`);
  }
  return lines.join('\n') + '\n';
}

async function runRefereeAutopilot({
  root,
  runtimeRoot,
  row,
  venues = [],
  execute = false,
  maxRounds = 6,
  targetOverride = null,
  datasetRoot = null,
  benchmarkId = null,
  applyManuscript = false,
} = {}) {
  const roundLimit = Math.max(1, Math.min(20, Number(maxRounds) || 6));
  const minimumFreshRefereeRounds = 1;
  const normalizedTargetOverride = normalizeText(targetOverride || '');
  const effectiveTarget = normalizedTargetOverride || row.task.venueTarget || '';
  const targetOverrideApplied = Boolean(normalizedTargetOverride);
  const journalConferenceRegistry = buildJournalConferenceRegistry();
  const targetSelectionPolicy = buildTargetSelectionPolicy({
    paperTask: row.task,
    target: effectiveTarget,
    hints: [row.task.title, row.task.paperType, row.task.paperId],
    registry: journalConferenceRegistry,
  });
  const targetJournalProfile = buildJournalTargetProfile({
    paperTask: row.task,
    target: effectiveTarget,
    registry: journalConferenceRegistry,
    targetSelectionPolicy,
    hints: [row.task.title, row.task.paperType, row.task.paperId],
  });
  const rounds = [];
  let accepted = false;
  let finalBuildResult = null;
  let finalPackageResult = null;
  let finalResearchReport = null;
  let finalEmpiricalAnalysis = null;
  let finalLifecycle = null;
  let finalRefereeReview = null;
  let finalRefereeRevision = null;
  let finalFreshRefereeReview = null;
  let finalFreshRefereeVerdict = null;
  let finalJournalRubricPacket = null;
  let finalVenueRubricManager = null;
  let finalFreshRefereePool = null;
  let finalVenueEvidenceGate = null;
  let finalVenueLifecyclePolicy = null;
  let journalConferenceSystemPacket = null;
  let sourceMutationCount = 0;
  let sqliteWriteCount = 0;
  let freshRefereeAcceptCount = 0;
  let freshRefereeReviseCount = 0;

  for (let roundIndex = 1; roundIndex <= roundLimit; roundIndex += 1) {
    const openBefore = openRefereeIssueCount(root, row.task.paperId);
    const roundStartedAt = nowIso();
    const refereeReview = await runRefereeReviewAdapter({
      root,
      runtimeRoot,
      row,
      execute: Boolean(execute),
    });
    const refereeRevision = await runRefereeReviseAdapter({
      root,
      runtimeRoot,
      row,
      mode: 'dry-run',
      execute: Boolean(execute),
    });
    let buildResult = await runLatexBuildAdapter({
      root,
      row,
      runtimeRoot,
      execute: false,
    });
    let packageResult = await runPackageAdapter({
      root,
      row,
      buildResult,
      runtimeRoot,
      execute: Boolean(execute),
    });
    let researchReport = await runResearchVerifyAdapter({ root, row, runtimeRoot });
    let empiricalAnalysis = null;
    if (execute && researchReport?.status !== 'evidence_present') {
      empiricalAnalysis = await runEmpiricalAnalysisAdapter({
        root,
        runtimeRoot,
        row,
        targetProfile: targetJournalProfile,
        targetSelectionPolicy,
        datasetRoot,
        benchmarkId,
        applyManuscript,
        execute: true,
      });
      if (empiricalAnalysis?.empiricalEvidenceGate?.status === 'empirical_evidence_gate_ready') {
        if (empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied') {
          buildResult = await runLatexBuildAdapter({
            root,
            row,
            runtimeRoot,
            execute: true,
          });
          packageResult = await runPackageAdapter({
            root,
            row,
            buildResult,
            runtimeRoot,
            execute: true,
          });
        }
        researchReport = await runResearchVerifyAdapter({ root, row, runtimeRoot });
      }
    }
    const lifecycle = buildSubmissionLifecycle({
      row,
      venues,
      artifactPackage: packageResult?.artifactPackage || null,
      researchReport,
      mode: PAPER_BATCH_MODES.REVIEWED_SUBMIT,
      reviewedSubmit: true,
    });
    const openAfter = openRefereeIssueCount(root, row.task.paperId);
    const freshRefereePool = buildFreshRefereePool({
      paperTask: row.task,
      targetProfile: targetJournalProfile,
      roundIndex,
    });
    const freshRefereeReview = await runRefereeReviewAdapter({
      root,
      runtimeRoot,
      row,
      execute: false,
      reviewerId: freshRefereePool.primaryRefereeId
        || `openclaw-fresh-referee-${roundIndex}-${targetJournalProfile.profile?.id || 'journal'}`,
      reviewScope: 'fresh_referee_verdict',
    });
    const venueRubricManager = buildVenueRubricManager({
      paperTask: row.task,
      targetProfile: targetJournalProfile,
      targetSelectionPolicy,
      roundIndex,
      sourceRecord: freshRefereeReview?.intake?.sourceRecord || null,
      refereePool: freshRefereePool,
    });
    const journalRubricPacket = buildJournalRubricPacket({
      paperTask: row.task,
      targetProfile: targetJournalProfile,
      targetSelectionPolicy,
      venueRubricManager,
      refereePool: freshRefereePool,
      roundIndex,
      sourceRecord: freshRefereeReview?.intake?.sourceRecord || null,
    });
    const venueEvidenceGate = buildVenueEvidenceGate({
      paperTask: row.task,
      targetProfile: targetJournalProfile,
      venueRubricManager,
      researchReport,
      packageResult,
    });
    const venueLifecyclePolicy = buildVenueLifecyclePolicy({
      paperTask: row.task,
      targetProfile: targetJournalProfile,
      evidenceGate: venueEvidenceGate,
      lifecycle,
    });
    const freshRefereeVerdict = buildFreshRefereeVerdict({
      paperTask: row.task,
      targetProfile: targetJournalProfile,
      rubricPacket: journalRubricPacket,
      venueRubricManager,
      refereePool: freshRefereePool,
      evidenceGate: venueEvidenceGate,
      lifecyclePolicy: venueLifecyclePolicy,
      reviewReport: freshRefereeReview?.reviewReport || null,
      openIssueCount: openAfter,
      buildResult,
      packageResult,
      researchReport,
      lifecycle,
      roundIndex,
    });
    const currentReviewFindingCount = Number(freshRefereeReview?.findingCount || 0);
    const newIssueRows = Number(refereeReview?.materializedIssueCount || 0);
    const sourceMutation = Boolean(refereeRevision?.patchApplyInvocation?.safety?.sourceMutation);
    const sqliteWrite = refereeRevision?.repairStateMutationReceipt?.status === 'repair_state_mutation_recorded';
    sourceMutationCount += sourceMutation ? 1 : 0;
    sqliteWriteCount += sqliteWrite ? 1 : 0;
    freshRefereeAcceptCount += freshRefereeVerdict.verdict === 'accept' ? 1 : 0;
    freshRefereeReviseCount += freshRefereeVerdict.verdict === 'revise' ? 1 : 0;
    const acceptanceReady = freshRefereeVerdict.verdict === 'accept'
      && roundIndex >= minimumFreshRefereeRounds;
    const roundStatus = acceptanceReady
      ? 'referee_autopilot_round_accept_ready'
      : freshRefereeVerdict.verdict === 'revise'
        ? 'referee_autopilot_round_fresh_referee_revise'
        : currentReviewFindingCount > 0
          ? 'referee_autopilot_round_reviewer_findings_remaining'
          : openAfter > 0
            ? 'referee_autopilot_round_revise_again_open_issues'
            : newIssueRows > 0
              ? 'referee_autopilot_round_recheck_required_after_new_issues'
              : 'referee_autopilot_round_blocked';

    rounds.push({
      kind: 'RefereeAutopilotRoundReceipt',
      paperId: row.task.paperId,
      taskKey: row.task.taskKey,
      roundIndex,
      status: roundStatus,
      requestedTargetOverride: normalizedTargetOverride || null,
      targetOverrideApplied,
      originalVenueTarget: row.task.venueTarget || null,
      effectiveTarget: normalizeText(effectiveTarget) || null,
      journalProfileId: targetJournalProfile.profile?.id || null,
      journalTargetProfileHash: targetJournalProfile.journalTargetProfileHash,
      targetSelectionPolicyHash: targetSelectionPolicy.targetSelectionPolicyHash,
      journalRubricPacketHash: journalRubricPacket.journalRubricPacketHash,
      venueRubricManagerHash: venueRubricManager.venueRubricManagerHash,
      freshRefereePoolHash: freshRefereePool.freshRefereePoolHash,
      venueEvidenceGateHash: venueEvidenceGate.venueEvidenceGateHash,
      venueLifecyclePolicyHash: venueLifecyclePolicy.venueLifecyclePolicyHash,
      freshRefereeId: freshRefereeVerdict.refereeId,
      freshRefereeVerdict: freshRefereeVerdict.verdict,
      freshRefereeVerdictStatus: freshRefereeVerdict.status,
      freshRefereeVerdictHash: freshRefereeVerdict.freshRefereeVerdictHash,
      startedAt: roundStartedAt,
      completedAt: nowIso(),
      openIssueCountBeforeReview: openBefore,
      reviewFindingCount: Number(refereeReview?.findingCount || 0),
      freshRefereeFindingCount: currentReviewFindingCount,
      reviewIssueRowsInserted: newIssueRows,
      reviewIssueRowsAlreadyPresent: Number(refereeReview?.existingIssueCount || 0),
      openIssueCountAfterRevise: openAfter,
      sourceMutation,
      sqliteWrite,
      packageStatus: packageResult?.artifactPackage?.packageStatus || packageResult?.status || null,
      empiricalAnalysisStatus: empiricalAnalysis?.status || null,
      empiricalEvidenceGateStatus: empiricalAnalysis?.empiricalEvidenceGate?.status || null,
      empiricalApplyStatus: empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status || null,
      empiricalExperimentRunReceiptStatus: empiricalAnalysis?.experimentRunReceipt?.status || null,
      empiricalResultArtifactPackageStatus: empiricalAnalysis?.resultArtifactPackage?.status || null,
      empiricalAnalysisBlockers: empiricalAnalysis?.blockers || [],
      empiricalDatasetMode: empiricalAnalysis?.datasetAccessContract?.datasetMode || null,
      localBenchmarkRegistryStatus: empiricalAnalysis?.localBenchmarkRegistry?.status || null,
      venueEvidenceGateStatus: venueEvidenceGate.status,
      venueLifecyclePolicyStatus: venueLifecyclePolicy.status,
      reviewedSubmitPreflightStatus: lifecycle?.reviewedSubmitPreflightPacket?.status || null,
      controlledExecutorReceiptStatus: lifecycle?.controlledExecutorReceipt?.status || null,
      freshRefereeBlockers: freshRefereeVerdict.blockers,
      externalActionPerformed: false,
    });

    finalBuildResult = buildResult;
    finalPackageResult = packageResult;
    finalResearchReport = researchReport;
    finalEmpiricalAnalysis = empiricalAnalysis || finalEmpiricalAnalysis;
    finalLifecycle = lifecycle;
    finalRefereeReview = refereeReview;
    finalRefereeRevision = refereeRevision;
    finalFreshRefereeReview = freshRefereeReview;
    finalFreshRefereeVerdict = freshRefereeVerdict;
    finalJournalRubricPacket = journalRubricPacket;
    finalVenueRubricManager = venueRubricManager;
    finalFreshRefereePool = freshRefereePool;
    finalVenueEvidenceGate = venueEvidenceGate;
    finalVenueLifecyclePolicy = venueLifecyclePolicy;
    if (acceptanceReady) {
      accepted = true;
      break;
    }
  }

  const finalOpenIssueCount = openRefereeIssueCount(root, row.task.paperId);
  journalConferenceSystemPacket = buildJournalConferenceSystemPacket({
    paperTask: row.task,
    registry: journalConferenceRegistry,
    targetSelectionPolicy,
    targetProfile: targetJournalProfile,
    rubricPacket: finalJournalRubricPacket,
    venueRubricManager: finalVenueRubricManager,
    freshRefereePool: finalFreshRefereePool,
    evidenceGate: finalVenueEvidenceGate,
    lifecyclePolicy: finalVenueLifecyclePolicy,
  });
  const blockers = [];
  if (!accepted) {
    blockers.push(finalOpenIssueCount > 0
      ? 'referee_autopilot_open_issues_after_max_rounds'
      : 'referee_autopilot_acceptance_not_reached_before_max_rounds');
    for (const blocker of finalFreshRefereeVerdict?.blockers || []) {
      blockers.push(blocker);
    }
  }
  const acceptanceReceipt = {
    kind: 'RefereeAutopilotAcceptanceReceipt',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: accepted ? 'referee_autopilot_accept_recorded' : 'referee_autopilot_accept_blocked',
    accepted,
    acceptanceActor: 'openclaw-agent-referee-autopilot',
    roundsCompleted: rounds.length,
    maxRounds: roundLimit,
    minimumFreshRefereeRounds,
    journalConferenceRegistryHash: journalConferenceRegistry.journalConferenceRegistryHash,
    targetSelectionPolicyHash: targetSelectionPolicy.targetSelectionPolicyHash,
    journalProfileId: targetJournalProfile.profile?.id || null,
    journalTargetProfileHash: targetJournalProfile.journalTargetProfileHash,
    finalJournalRubricPacketHash: finalJournalRubricPacket?.journalRubricPacketHash || null,
    finalVenueRubricManagerHash: finalVenueRubricManager?.venueRubricManagerHash || null,
    finalFreshRefereePoolHash: finalFreshRefereePool?.freshRefereePoolHash || null,
    finalVenueEvidenceGateHash: finalVenueEvidenceGate?.venueEvidenceGateHash || null,
    finalVenueLifecyclePolicyHash: finalVenueLifecyclePolicy?.venueLifecyclePolicyHash || null,
    journalConferenceSystemPacketHash: journalConferenceSystemPacket.journalConferenceSystemPacketHash,
    finalFreshRefereeVerdict: finalFreshRefereeVerdict?.verdict || null,
    finalFreshRefereeVerdictStatus: finalFreshRefereeVerdict?.status || null,
    finalFreshRefereeVerdictHash: finalFreshRefereeVerdict?.freshRefereeVerdictHash || null,
    finalFreshRefereeId: finalFreshRefereeVerdict?.refereeId || null,
    finalOpenIssueCount,
    requestedTargetOverride: normalizedTargetOverride || null,
    targetOverrideApplied,
    originalVenueTarget: row.task.venueTarget || null,
    effectiveTarget: normalizeText(effectiveTarget) || null,
    finalReviewStatus: finalFreshRefereeReview?.reviewReport?.status || null,
    finalReviewFindingCount: Number(finalFreshRefereeReview?.findingCount || 0),
    finalReviewIssueRowsInserted: Number(finalRefereeReview?.materializedIssueCount || 0),
    finalReviewedSubmitPreflightStatus: finalLifecycle?.reviewedSubmitPreflightPacket?.status || null,
    finalControlledExecutorReceiptStatus: finalLifecycle?.controlledExecutorReceipt?.status || null,
    blockers,
    safety: {
      sourceMutation: sourceMutationCount > 0,
      sqliteWrites: sqliteWriteCount > 0,
      externalActionPerformed: false,
      liveExternalSubmissionPerformed: false,
      targetOverrideRuntimeOnly: targetOverrideApplied,
      writesLegacyRegistry: false,
    },
  };
  const acceptanceReceiptWithHash = {
    ...acceptanceReceipt,
    refereeAutopilotAcceptanceReceiptHash: hashPaperRecord(
      'RefereeAutopilotAcceptanceReceipt',
      acceptanceReceipt,
    ),
  };
  if (runtimeRoot && (execute || rounds.length)) {
    const autopilotDir = path.join(runtimeRoot, 'referee-autopilot', row.task.paperId);
    await ensureDir(autopilotDir);
    await writeJsonFile(path.join(autopilotDir, 'AUTOPILOT_ROUNDS.json'), rounds);
    await writeJsonFile(path.join(autopilotDir, 'AUTOPILOT_ACCEPTANCE_RECEIPT.json'), acceptanceReceiptWithHash);
  }
  const report = {
    version: 1,
    kind: 'RefereeAutopilotReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: accepted ? 'referee_autopilot_accepted' : 'referee_autopilot_blocked',
    accepted,
    roundsCompleted: rounds.length,
    maxRounds: roundLimit,
    minimumFreshRefereeRounds,
    finalOpenIssueCount,
    requestedTargetOverride: normalizedTargetOverride || null,
    targetOverrideApplied,
    originalVenueTarget: row.task.venueTarget || null,
    effectiveTarget: normalizeText(effectiveTarget) || null,
    targetJournalProfile,
    journalConferenceRegistry,
    targetSelectionPolicy,
    finalJournalRubricPacket,
    finalVenueRubricManager,
    finalFreshRefereePool,
    finalVenueEvidenceGate,
    finalVenueLifecyclePolicy,
    journalConferenceSystemPacket,
    finalFreshRefereeReview,
    finalFreshRefereeVerdict,
    freshRefereeVerdictCount: rounds.length,
    freshRefereeAcceptCount,
    freshRefereeReviseCount,
    sourceMutationCount,
    sqliteWriteCount,
    rounds,
    finalRefereeReview,
    finalRefereeRevision,
    finalBuildResult,
    finalPackageResult,
    finalResearchReport,
    finalEmpiricalAnalysis,
    finalLifecycle,
    acceptanceReceipt: acceptanceReceiptWithHash,
    blockers,
    safety: {
      sourceMutation: sourceMutationCount > 0,
      sqliteWrites: sqliteWriteCount > 0,
      externalActionPerformed: false,
      liveExternalSubmissionPerformed: false,
      importsOldControlPlane: false,
      targetOverrideRuntimeOnly: targetOverrideApplied,
      writesLegacyRegistry: false,
    },
  };
  return {
    ...report,
    refereeAutopilotReportHash: hashPaperRecord('RefereeAutopilotReport', report),
  };
}

export async function runPaperBatch({
  root = defaultRoot(),
  runtimeRoot = null,
  mode = PAPER_BATCH_MODES.INVENTORY,
  limit = null,
  paperIds = [],
  includeRetired = false,
  includeQuarantined = false,
  inventorySource = 'auto',
  execute = false,
  writeReport = false,
  maxRounds = 6,
  targetOverride = null,
  datasetRoot = null,
  benchmarkId = null,
  applyManuscript = false,
} = {}) {
  if (!MODE_SET.has(mode)) throw new Error(`Unknown paper batch mode: ${mode}`);
  const resolvedRoot = path.resolve(root);
  const resolvedRuntimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : defaultRuntimeRoot(resolvedRoot);
  const scan = await discoverInventory({
    root: resolvedRoot,
    limit,
    paperIds,
    includeRetired,
    includeQuarantined,
    inventorySource,
  });
  const legacyCleanupAudit = mode === PAPER_BATCH_MODES.LEGACY_CLEANUP
    ? await runLegacyCleanupAdapter({
      root: resolvedRoot,
      runtimeRoot: resolvedRuntimeRoot,
      execute,
    })
    : null;
  const results = [];
  for (const row of scan.rows) {
    let buildResult = null;
    let packageResult = null;
    let researchReport = null;
    let refereeReview = null;
    let refereeRevision = null;
    let refereeAutopilot = null;
    let journalManagement = null;
    let empiricalAnalysis = null;
    let venueResolution = null;
    let sourceAdaptation = null;
    let lifecycle = null;
    if (modeNeedsRefereeAutopilot(mode)) {
      journalManagement = await runJournalManageAdapter({
        root: resolvedRoot,
        runtimeRoot: resolvedRuntimeRoot,
        row,
        target: targetOverride,
        execute: execute && mode === PAPER_BATCH_MODES.REFEREE_AUTOPILOT,
      });
      refereeAutopilot = await runRefereeAutopilot({
        root: resolvedRoot,
        runtimeRoot: resolvedRuntimeRoot,
        row,
        venues: scan.venues,
        execute: execute && mode === PAPER_BATCH_MODES.REFEREE_AUTOPILOT,
        maxRounds,
        targetOverride,
        datasetRoot,
        benchmarkId,
        applyManuscript,
      });
      buildResult = refereeAutopilot.finalBuildResult;
      packageResult = refereeAutopilot.finalPackageResult;
      researchReport = refereeAutopilot.finalResearchReport;
      empiricalAnalysis = refereeAutopilot.finalEmpiricalAnalysis;
      lifecycle = refereeAutopilot.finalLifecycle;
      refereeReview = refereeAutopilot.finalRefereeReview;
      refereeRevision = refereeAutopilot.finalRefereeRevision;
    }
    if (modeNeedsJournalManage(mode)) {
      journalManagement = await runJournalManageAdapter({
        root: resolvedRoot,
        runtimeRoot: resolvedRuntimeRoot,
        row,
        target: targetOverride,
        execute: execute && mode === PAPER_BATCH_MODES.JOURNAL_MANAGE,
      });
    }
    if (modeNeedsEmpiricalAnalysis(mode)) {
      journalManagement = await runJournalManageAdapter({
        root: resolvedRoot,
        runtimeRoot: resolvedRuntimeRoot,
        row,
        target: targetOverride,
        execute: execute && mode === PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS,
      });
      empiricalAnalysis = await runEmpiricalAnalysisAdapter({
        root: resolvedRoot,
        runtimeRoot: resolvedRuntimeRoot,
        row,
        targetProfile: journalManagement?.targetProfile || null,
        targetSelectionPolicy: journalManagement?.targetSelectionPolicy || null,
        datasetRoot,
        benchmarkId,
        applyManuscript,
        execute: execute && mode === PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS,
      });
      if (empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied') {
        buildResult = await runLatexBuildAdapter({
          root: resolvedRoot,
          row,
          runtimeRoot: resolvedRuntimeRoot,
          execute: execute && mode === PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS,
        });
        packageResult = await runPackageAdapter({
          root: resolvedRoot,
          row,
          buildResult,
          runtimeRoot: resolvedRuntimeRoot,
          execute: execute && mode === PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS,
        });
      }
      researchReport = await runResearchVerifyAdapter({
        root: resolvedRoot,
        row,
        runtimeRoot: resolvedRuntimeRoot,
      });
    }
    if (modeNeedsBuild(mode)) {
      buildResult = await runLatexBuildAdapter({
        root: resolvedRoot,
        row,
        runtimeRoot: resolvedRuntimeRoot,
        execute: execute && mode === PAPER_BATCH_MODES.LOCAL_BUILD,
      });
    }
    if (modeNeedsPackage(mode)) {
      packageResult = await runPackageAdapter({
        root: resolvedRoot,
        row,
        buildResult,
        runtimeRoot: resolvedRuntimeRoot,
        execute: execute && mode === PAPER_BATCH_MODES.LOCAL_PACKAGE,
      });
    }
    if (modeNeedsResearch(mode)) {
      researchReport = await runResearchVerifyAdapter({
        root: resolvedRoot,
        row,
        runtimeRoot: resolvedRuntimeRoot,
      });
    }
    if (modeNeedsRefereeReview(mode)) {
      refereeReview = await runRefereeReviewAdapter({
        root: resolvedRoot,
        runtimeRoot: resolvedRuntimeRoot,
        row,
        execute: execute && mode === PAPER_BATCH_MODES.REFEREE_REVIEW,
      });
    }
    if (modeNeedsRefereeRevise(mode)) {
      refereeRevision = await runRefereeReviseAdapter({
        root: resolvedRoot,
        runtimeRoot: resolvedRuntimeRoot,
        row,
        mode: 'dry-run',
        execute: execute && mode === PAPER_BATCH_MODES.REFEREE_REVISE,
      });
    }
    if (modeNeedsVenueResolve(mode)) {
      venueResolution = await runVenueResolveAdapter({
        row,
        venues: scan.venues,
        packageResult,
      });
    }
    if (modeNeedsSourceAdapt(mode)) {
      sourceAdaptation = await runSourceAdaptAdapter({
        root: resolvedRoot,
        row,
      });
    }
    if (modeNeedsSubmission(mode)) {
      const submissionIntent = row.submissionIntent || row.task.registry?.submissionIntent;
      if (!submissionIntent || submissionIntent.status === 'submission_candidate') {
        lifecycle = buildSubmissionLifecycle({
          row,
          venues: scan.venues,
          artifactPackage: packageResult?.artifactPackage || null,
          researchReport,
          mode,
          reviewedSubmit: mode === PAPER_BATCH_MODES.REVIEWED_SUBMIT,
        });
      }
    }
    const state = stateWithAdapterResults(row, {
      buildResult,
      packageResult,
      researchReport,
      refereeRevision,
      refereeReview,
      venueResolution,
      sourceAdaptation,
      lifecycle,
    });
    results.push({
      paperId: row.task.paperId,
      task: row.task,
      state,
      workflowRow: paperWorkflowRow(state),
      buildResult,
      packageResult,
      researchReport,
      refereeReview,
      refereeRevision,
      refereeAutopilot,
      journalManagement,
      empiricalAnalysis,
      venueResolution,
      sourceAdaptation,
      lifecycle,
    });
  }
  const rows = results.map((item) => item.workflowRow);
  const blockerFamilies = blockerFamilySummary(results);
  const report = {
    version: 1,
    kind: 'PaperBatchRunReport',
    generatedAt: nowIso(),
    root: resolvedRoot,
    runtimeRoot: resolvedRuntimeRoot,
    mode,
    execute: Boolean(execute),
    requestedTargetOverride: normalizeText(targetOverride || '') || null,
    requestedDatasetRoot: normalizeText(datasetRoot || '') || null,
    requestedBenchmarkId: normalizeText(benchmarkId || '') || null,
    requestedApplyManuscript: Boolean(applyManuscript),
    registryRefs: scan.registryRefs,
    inventory: {
      source: scan.inventorySource,
      fallback: scan.inventoryFallback,
      quarantinedCount: scan.quarantined?.length || 0,
      quarantined: scan.quarantined || [],
    },
    summary: {
      ...summarizeRows(rows, mode),
      ...summarizeResults(results, legacyCleanupAudit),
      blockerFamilies,
    },
    rows,
    results,
    legacyCleanupAudit,
    markdownTable: makeMarkdownTable(rows),
    blockerFamilyTable: makeBlockerFamilyMarkdown(blockerFamilies),
    safety: {
      coreSnapshotModified: false,
      importsOldPaperFactoryControlPlane: false,
      externalActionPerformed: false,
      reviewedSubmitBlockedByDefault: true,
    },
  };
  if (writeReport) {
    await ensureDir(path.join(resolvedRuntimeRoot, 'reports'));
    const stamp = report.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const base = path.join(resolvedRuntimeRoot, 'reports', `paper-batch-${mode}-${stamp}`);
    await writeJsonFile(base + '.json', report);
    await writeTextFile(base + '.md', [
      `# Paper Batch ${mode}`,
      '',
      '```json',
      JSON.stringify(report.summary, null, 2),
      '```',
      '',
      '## Blocker Families',
      '',
      report.blockerFamilyTable,
      '',
      '## Batch Table',
      '',
      report.markdownTable,
    ].join('\n'));
    await writeJsonFile(path.join(resolvedRuntimeRoot, 'reports', `paper-batch-${mode}-latest.json`), report);
    await writeTextFile(path.join(resolvedRuntimeRoot, 'reports', `paper-batch-${mode}-latest.md`), [
      `# Paper Batch ${mode}`,
      '',
      '## Summary',
      '',
      '```json',
      JSON.stringify(report.summary, null, 2),
      '```',
      '',
      '## Blocker Families',
      '',
      report.blockerFamilyTable,
      '',
      '## Batch Table',
      '',
      report.markdownTable,
    ].join('\n'));
  }
  return report;
}

export function renderBatchConsole(report) {
  return [
    `paper-production-core ${report.mode}`,
    JSON.stringify(report.summary),
    '',
    report.markdownTable,
  ].join('\n');
}
