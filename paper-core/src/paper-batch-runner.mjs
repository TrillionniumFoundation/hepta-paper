import path from 'node:path';
import {
  ensureDir,
  nowIso,
  normalizeText,
} from './utils.mjs';
import { writeJsonFile, writeTextFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import {
  PAPER_ACTIONS,
  createPaperWorkflowState,
  autoLevelForState,
  inferPaperStage,
  nextActionForState,
  paperWorkflowRow,
  hashPaperRecord,
} from './paper-contracts.mjs';
import { buildCoreIntegrityReport } from './core-integrity.mjs';
import { heptaStorePath } from './hepta-store.mjs';
import { createExecutionContext } from './execution-context.mjs';
import { PAPER_BATCH_MODES, assertPaperMode } from './mode-registry.mjs';
import { runWorkflowStages } from './workflow-engine.mjs';
import { createSqliteStore } from '../../paper-adapters/persistence/sqlite-store.mjs';
import { sqlEscape } from '../../paper-ports/store-port.mjs';
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
import {
  buildSubmissionLifecycle,
  prepareSubmissionAuthorities,
} from '../../paper-adapters/submission/index.mjs';
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

export { PAPER_BATCH_MODES } from './mode-registry.mjs';

function defaultRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
}

function defaultRuntimeRoot(root) {
  return path.join(root, 'hepta-paper-workspace', 'runtime');
}

function openRefereeIssueCount(store, paperId) {
  const rows = store.query(
    [
      'select count(*) as count from referee_revision_requests',
      `where slug='${sqlEscape(paperId)}'`,
      "and status not in ('resolved','closed');",
    ].join(' '),
  ).rows;
  return Number(rows[0]?.count || 0);
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
    ...(lifecycle?.reviewedSubmit ? (lifecycle?.approvalPacket?.blockers || []) : []),
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

import {
  blockerFamilySummary,
  makeBlockerFamilyMarkdown,
  makeMarkdownTable,
  summarizeResults,
  summarizeRows,
} from './batch-summary.mjs';
async function runLocalDiagnosticReviewLoop({
  root,
  runtimeRoot,
  store,
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
  let diagnosticClosureReached = false;
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
  let diagnosticPassCount = 0;
  let freshRefereeReviseCount = 0;

  for (let roundIndex = 1; roundIndex <= roundLimit; roundIndex += 1) {
    const openBefore = openRefereeIssueCount(store, row.task.paperId);
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
    const submissionAuthorities = await prepareSubmissionAuthorities({
      root,
      runtimeRoot,
      row,
      venues,
      artifactPackage: packageResult?.artifactPackage || null,
      researchReport,
      mode: PAPER_BATCH_MODES.REVIEWED_SUBMIT,
    });
    const lifecycle = buildSubmissionLifecycle({
      row,
      venues,
      artifactPackage: packageResult?.artifactPackage || null,
      researchReport,
      mode: PAPER_BATCH_MODES.REVIEWED_SUBMIT,
      reviewedSubmit: true,
      venuePlanOverride: submissionAuthorities.venuePlan,
      independentReviewAuthorityReceipt:
        submissionAuthorities.independentReviewAuthorityReceipt,
      liveAuthorizationReceipt: submissionAuthorities.liveAuthorizationReceipt,
    });
    const openAfter = openRefereeIssueCount(store, row.task.paperId);
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
      independentReviewAuthorityReceipt: lifecycle.independentReviewAuthorityReceipt,
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
    diagnosticPassCount += freshRefereeVerdict.verdict === 'accept' ? 1 : 0;
    freshRefereeReviseCount += freshRefereeVerdict.verdict === 'revise' ? 1 : 0;
    const diagnosticClosureReady = freshRefereeVerdict.verdict === 'accept'
      && roundIndex >= minimumFreshRefereeRounds;
    const roundStatus = diagnosticClosureReady
      ? 'local_diagnostic_review_round_passed'
      : freshRefereeVerdict.verdict === 'revise'
        ? 'local_diagnostic_review_round_revise'
        : currentReviewFindingCount > 0
          ? 'local_diagnostic_review_round_findings_remaining'
          : openAfter > 0
            ? 'local_diagnostic_review_round_open_issues'
            : newIssueRows > 0
              ? 'local_diagnostic_review_round_recheck_required'
              : 'local_diagnostic_review_round_blocked';

    rounds.push({
      kind: 'LocalDiagnosticReviewRoundReceipt',
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
      localHeuristicVerdict: freshRefereeVerdict.verdict,
      diagnosticVerdict: freshRefereeVerdict.verdict === 'accept' ? 'pass' : 'revise',
      academicAcceptanceGranted: false,
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
    if (diagnosticClosureReady) {
      diagnosticClosureReached = true;
      break;
    }
  }

  const finalOpenIssueCount = openRefereeIssueCount(store, row.task.paperId);
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
  if (!diagnosticClosureReached) {
    blockers.push(finalOpenIssueCount > 0
      ? 'local_diagnostic_review_open_issues_after_max_rounds'
      : 'local_diagnostic_review_pass_not_reached_before_max_rounds');
    for (const blocker of finalFreshRefereeVerdict?.blockers || []) {
      blockers.push(blocker);
    }
  }
  const diagnosticReceipt = {
    kind: 'LocalDiagnosticReviewLoopReceipt',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: diagnosticClosureReached ? 'local_diagnostic_review_pass_recorded' : 'local_diagnostic_review_blocked',
    diagnosticClosureReached,
    academicAcceptanceGranted: false,
    diagnosticActor: 'local-deterministic-review-loop',
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
  const diagnosticReceiptWithHash = {
    ...diagnosticReceipt,
    localDiagnosticReviewLoopReceiptHash: hashPaperRecord(
      'LocalDiagnosticReviewLoopReceipt',
      diagnosticReceipt,
    ),
  };
  if (runtimeRoot && (execute || rounds.length)) {
    const loopDir = path.join(runtimeRoot, 'local-review-loop', row.task.paperId);
    await ensureDir(loopDir);
    await writeJsonFile(path.join(loopDir, 'LOCAL_DIAGNOSTIC_REVIEW_ROUNDS.json'), rounds, { scopeRoot: loopDir });
    await writeJsonFile(path.join(loopDir, 'LOCAL_DIAGNOSTIC_REVIEW_RECEIPT.json'), diagnosticReceiptWithHash, { scopeRoot: loopDir });
  }
  const report = {
    version: 1,
    kind: 'LocalDiagnosticReviewLoopReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: diagnosticClosureReached ? 'local_diagnostic_review_passed' : 'local_diagnostic_review_blocked',
    diagnosticClosureReached,
    academicAcceptanceGranted: false,
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
    diagnosticPassCount,
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
    diagnosticReceipt: diagnosticReceiptWithHash,
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
    localDiagnosticReviewLoopReportHash: hashPaperRecord('LocalDiagnosticReviewLoopReport', report),
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
  const workflowDefinition = assertPaperMode(mode);
  const resolvedRoot = path.resolve(root);
  const resolvedRuntimeRoot = runtimeRoot ? path.resolve(runtimeRoot) : defaultRuntimeRoot(resolvedRoot);
  const store = createSqliteStore({ dbPath: heptaStorePath(resolvedRoot) });
  const executionContext = createExecutionContext({
    root: resolvedRoot,
    runtimeRoot: resolvedRuntimeRoot,
    mode,
    execute,
    writeReport,
    options: {
      maxRounds,
      targetOverride,
      datasetRoot,
      benchmarkId,
      applyManuscript,
    },
    services: { store },
  });
  const coreIntegrity = buildCoreIntegrityReport({
    workspaceRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
  });
  if (execute && !coreIntegrity.ok) {
    throw new Error(`Core integrity gate blocked execution: ${coreIntegrity.status}`);
  }
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
    const initialStageState = {
      buildResult: null,
      packageResult: null,
      researchReport: null,
      refereeReview: null,
      refereeRevision: null,
      localDiagnosticReviewLoop: null,
      journalManagement: null,
      empiricalAnalysis: null,
      venueResolution: null,
      sourceAdaptation: null,
      lifecycle: null,
    };
    const handlers = {
      'local-review-loop': async () => {
        const localReviewLoopMode = [PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP, PAPER_BATCH_MODES.REFEREE_AUTOPILOT].includes(mode);
        const journalManagement = await runJournalManageAdapter({
          root: resolvedRoot,
          runtimeRoot: resolvedRuntimeRoot,
          row,
          target: targetOverride,
          execute: execute && localReviewLoopMode,
        });
        const localDiagnosticReviewLoop = await runLocalDiagnosticReviewLoop({
          root: resolvedRoot,
          runtimeRoot: resolvedRuntimeRoot,
          store: executionContext.services.store,
          row,
          venues: scan.venues,
          execute: execute && localReviewLoopMode,
          maxRounds,
          targetOverride,
          datasetRoot,
          benchmarkId,
          applyManuscript,
        });
        return {
          journalManagement,
          localDiagnosticReviewLoop,
          buildResult: localDiagnosticReviewLoop.finalBuildResult,
          packageResult: localDiagnosticReviewLoop.finalPackageResult,
          researchReport: localDiagnosticReviewLoop.finalResearchReport,
          empiricalAnalysis: localDiagnosticReviewLoop.finalEmpiricalAnalysis,
          lifecycle: localDiagnosticReviewLoop.finalLifecycle,
          refereeReview: localDiagnosticReviewLoop.finalRefereeReview,
          refereeRevision: localDiagnosticReviewLoop.finalRefereeRevision,
        };
      },
      'journal-manage': async () => ({
        journalManagement: await runJournalManageAdapter({
          root: resolvedRoot,
          runtimeRoot: resolvedRuntimeRoot,
          row,
          target: targetOverride,
          execute: execute && mode === PAPER_BATCH_MODES.JOURNAL_MANAGE,
        }),
      }),
      'empirical-analysis': async () => {
        const journalManagement = await runJournalManageAdapter({
          root: resolvedRoot,
          runtimeRoot: resolvedRuntimeRoot,
          row,
          target: targetOverride,
          execute: execute && mode === PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS,
        });
        const empiricalAnalysis = await runEmpiricalAnalysisAdapter({
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
        let buildResult = null;
        let packageResult = null;
        if (empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied') {
          buildResult = await runLatexBuildAdapter({ root: resolvedRoot, row, runtimeRoot: resolvedRuntimeRoot, execute });
          packageResult = await runPackageAdapter({ root: resolvedRoot, row, buildResult, runtimeRoot: resolvedRuntimeRoot, execute });
        }
        const researchReport = await runResearchVerifyAdapter({ root: resolvedRoot, row, runtimeRoot: resolvedRuntimeRoot });
        return { journalManagement, empiricalAnalysis, buildResult, packageResult, researchReport };
      },
      build: async () => ({
        buildResult: await runLatexBuildAdapter({
          root: resolvedRoot,
          row,
          runtimeRoot: resolvedRuntimeRoot,
          execute: execute && mode === PAPER_BATCH_MODES.LOCAL_BUILD,
        }),
      }),
      package: async ({ state: stageState }) => ({
        packageResult: await runPackageAdapter({
          root: resolvedRoot,
          row,
          buildResult: stageState.buildResult,
          runtimeRoot: resolvedRuntimeRoot,
          execute: execute && mode === PAPER_BATCH_MODES.LOCAL_PACKAGE,
        }),
      }),
      'research-verify': async () => ({
        researchReport: await runResearchVerifyAdapter({
          root: resolvedRoot,
          row,
          runtimeRoot: resolvedRuntimeRoot,
          executeResearchWorkers: execute && mode === PAPER_BATCH_MODES.RESEARCH_VERIFY,
          requireNativeWorkers: mode === PAPER_BATCH_MODES.RESEARCH_VERIFY,
        }),
      }),
      'referee-review': async () => ({
        refereeReview: await runRefereeReviewAdapter({
          root: resolvedRoot,
          runtimeRoot: resolvedRuntimeRoot,
          row,
          execute: execute && mode === PAPER_BATCH_MODES.REFEREE_REVIEW,
        }),
      }),
      'referee-revise': async () => ({
        refereeRevision: await runRefereeReviseAdapter({
          root: resolvedRoot,
          runtimeRoot: resolvedRuntimeRoot,
          row,
          mode: 'dry-run',
          execute: execute && mode === PAPER_BATCH_MODES.REFEREE_REVISE,
        }),
      }),
      'venue-resolve': async ({ state: stageState }) => ({
        venueResolution: await runVenueResolveAdapter({ row, venues: scan.venues, packageResult: stageState.packageResult }),
      }),
      'source-adapt': async () => ({
        sourceAdaptation: await runSourceAdaptAdapter({ root: resolvedRoot, row }),
      }),
      submission: async ({ state: stageState }) => {
        const submissionIntent = row.submissionIntent || row.task.registry?.submissionIntent;
        if (submissionIntent && submissionIntent.status !== 'submission_candidate') return { lifecycle: null };
        const submissionAuthorities = await prepareSubmissionAuthorities({
          root: resolvedRoot,
          runtimeRoot: resolvedRuntimeRoot,
          row,
          venues: scan.venues,
          artifactPackage: stageState.packageResult?.artifactPackage || null,
          researchReport: stageState.researchReport,
          mode,
        });
        return {
          lifecycle: buildSubmissionLifecycle({
            row,
            venues: scan.venues,
            artifactPackage: stageState.packageResult?.artifactPackage || null,
            researchReport: stageState.researchReport,
            mode,
            reviewedSubmit: mode === PAPER_BATCH_MODES.REVIEWED_SUBMIT,
            venuePlanOverride: submissionAuthorities.venuePlan,
            independentReviewAuthorityReceipt: submissionAuthorities.independentReviewAuthorityReceipt,
            liveAuthorizationReceipt: submissionAuthorities.liveAuthorizationReceipt,
          }),
        };
      },
    };
    const workflowExecution = await runWorkflowStages({
      definition: workflowDefinition,
      context: executionContext,
      initialState: initialStageState,
      handlers,
    });
    const {
      buildResult,
      packageResult,
      researchReport,
      refereeReview,
      refereeRevision,
      localDiagnosticReviewLoop,
      journalManagement,
      empiricalAnalysis,
      venueResolution,
      sourceAdaptation,
      lifecycle,
    } = workflowExecution.state;
    const state = stateWithAdapterResults(row, {
      buildResult,
      packageResult,
      researchReport,
      refereeRevision,
      refereeReview,
      venueResolution,
      sourceAdaptation,
      lifecycle,
      workflowReceipt: workflowExecution.workflowReceipt,
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
      localDiagnosticReviewLoop,
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
    coreIntegrity,
    markdownTable: makeMarkdownTable(rows),
    blockerFamilyTable: makeBlockerFamilyMarkdown(blockerFamilies),
    safety: {
      coreSnapshotModified: coreIntegrity.coreSnapshotModified,
      coreIntegrityStatus: coreIntegrity.status,
      upstreamCoreSnapshotExactMatch: coreIntegrity.upstream.exactMatch,
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
