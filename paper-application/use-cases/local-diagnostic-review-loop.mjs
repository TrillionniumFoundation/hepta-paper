import path from 'node:path';
import { ensureDir } from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText } from '../../paper-core/src/runtime/text-utils.mjs';
import { nowIso } from '../../paper-core/src/runtime/time-utils.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';
import { PAPER_BATCH_MODES } from '../../paper-core/src/mode-registry.mjs';
import { sqlEscape } from '../../paper-ports/store-port.mjs';
import { writeJsonFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import { runLatexBuildAdapter, runPackageAdapter } from '../../paper-adapters/build-package/index.mjs';
import { runEmpiricalAnalysisAdapter } from '../../paper-adapters/empirical-analysis/index.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import { runRefereeReviewAdapter } from '../../paper-adapters/referee-review/index.mjs';
import { runRefereeReviseAdapter } from '../../paper-adapters/referee-revise/index.mjs';
import { buildSubmissionLifecycle, prepareSubmissionAuthorities } from '../../paper-adapters/submission/index.mjs';
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
} from '../../paper-adapters/journal-manage/index.mjs';

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

export async function runLocalDiagnosticReviewLoop({
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
  authorityVerifier = null,
  submissionDeliveryStore = null,
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
      store,
    });
    const refereeRevision = await runRefereeReviseAdapter({
      root,
      runtimeRoot,
      row,
      mode: 'dry-run',
      execute: Boolean(execute),
      store,
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
      store,
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
            store,
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
      authorityVerifier,
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
      deliveryStore: submissionDeliveryStore,
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
      store,
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
