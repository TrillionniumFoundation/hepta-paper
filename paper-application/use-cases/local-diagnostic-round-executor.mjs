import { nowIso } from '../../workflow-kernel/runtime/time-utils.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { sqlEscape } from '../../paper-ports/store-port.mjs';
import { PAPER_BATCH_MODES } from '../../paper-domain/workflow/mode-registry.mjs';
import { runLatexBuildAdapter, runPackageAdapter } from '../../paper-adapters/build-package/index.mjs';
import { runEmpiricalAnalysisAdapter } from '../../paper-adapters/empirical-analysis/index.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import { runRefereeReviewAdapter } from '../../paper-adapters/referee-review/index.mjs';
import { runRefereeReviseAdapter } from '../../paper-adapters/referee-revise/index.mjs';
import { buildSubmissionLifecycle, prepareSubmissionAuthorities } from '../../paper-adapters/submission/index.mjs';
import {
  buildFreshRefereeVerdict, buildFreshRefereePool, buildJournalRubricPacket,
  buildVenueEvidenceGate, buildVenueLifecyclePolicy, buildVenueRubricManager,
} from '../../paper-adapters/journal-manage/index.mjs';

function openRefereeIssueCount(store, paperId) {
  return Number(store.query(`select count(*) as count from referee_revision_requests where slug='${sqlEscape(paperId)}' and status not in ('resolved','closed');`).rows[0]?.count || 0);
}

export async function executeLocalDiagnosticRound({
  root, runtimeRoot, services, row, venues, execute, roundIndex, effectiveTarget,
  normalizedTargetOverride, targetOverrideApplied, targetJournalProfile, targetSelectionPolicy,
  datasetRoot, benchmarkId, applyManuscript,
} = {}) {
  const roundStartedAt = nowIso();
  const openBefore = openRefereeIssueCount(services.store, row.task.paperId);
  const refereeReview = await runRefereeReviewAdapter({ root, runtimeRoot, row, execute: Boolean(execute), store: services.store });
  const refereeRevision = await runRefereeReviseAdapter({ root, runtimeRoot, row, mode: 'dry-run', execute: Boolean(execute), store: services.store });
  let buildResult = await runLatexBuildAdapter({ root, row, runtimeRoot, execute: false });
  let packageResult = await runPackageAdapter({ root, row, buildResult, runtimeRoot, execute: Boolean(execute), store: services.store });
  const verifyResearch = () => runResearchVerifyAdapter({
    root, row, runtimeRoot, authorityVerifier: services.authorityVerifier,
    jobReceiptStore: services.jobReceiptStore, artifactRepositoryFactory: services.artifactRepositoryFactory,
    receiptLedger: services.receiptLedger, clock: services.clock,
  });
  let researchReport = await verifyResearch();
  let empiricalAnalysis = null;
  if (execute && researchReport?.status !== 'evidence_present') {
    empiricalAnalysis = await runEmpiricalAnalysisAdapter({ root, runtimeRoot, row, targetProfile: targetJournalProfile, targetSelectionPolicy, datasetRoot, benchmarkId, applyManuscript, execute: true });
    if (empiricalAnalysis?.empiricalEvidenceGate?.status === 'empirical_evidence_gate_ready') {
      if (empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied') {
        buildResult = await runLatexBuildAdapter({ root, row, runtimeRoot, execute: true });
        packageResult = await runPackageAdapter({ root, row, buildResult, runtimeRoot, execute: true, store: services.store });
      }
      researchReport = await verifyResearch();
    }
  }
  const executorDescriptor = services.submissionExecutorDescriptor || null;
  const venuePreflightObservation = row.venuePreflightObservation || row.task.registry?.venuePreflightObservation || null;
  const signedVenueObservation = row.signedVenueObservation || row.task.registry?.signedVenueObservation || null;
  const submissionAuthorities = await prepareSubmissionAuthorities({ root, runtimeRoot, row, venues, artifactPackage: packageResult?.artifactPackage || null, researchReport, mode: PAPER_BATCH_MODES.REVIEWED_SUBMIT, authorityVerifier: services.authorityVerifier, executorDescriptor, submissionMetadata: row.submissionMetadata || row.task.registry?.submissionMetadata || null, submissionMetadataReview: row.submissionMetadataReview || row.task.registry?.submissionMetadataReview || null, venuePreflightObservation, signedVenueObservation, receiptLedger: services.receiptLedger });
  const lifecycle = buildSubmissionLifecycle({
    row, venues, artifactPackage: packageResult?.artifactPackage || null, researchReport,
    mode: PAPER_BATCH_MODES.REVIEWED_SUBMIT, reviewedSubmit: true,
    venuePlanOverride: submissionAuthorities.venuePlan,
    independentReviewAuthorityReceipt: submissionAuthorities.independentReviewAuthorityReceipt,
    liveAuthorizationReceipt: submissionAuthorities.liveAuthorizationReceipt,
    submissionDecisionPacket: submissionAuthorities.submissionDecisionPacket,
    executorDescriptor,
    venuePreflightObservation,
    reviewedVenueEvidenceOverride: submissionAuthorities.reviewedVenueEvidence,
    deliveryStore: services.submissionDeliveryStore,
  });
  const openAfter = openRefereeIssueCount(services.store, row.task.paperId);
  const freshRefereePool = buildFreshRefereePool({ paperTask: row.task, targetProfile: targetJournalProfile, roundIndex });
  const freshRefereeReview = await runRefereeReviewAdapter({ root, runtimeRoot, row, execute: false, reviewerId: freshRefereePool.primaryRefereeId || `openclaw-fresh-referee-${roundIndex}-${targetJournalProfile.profile?.id || 'journal'}`, reviewScope: 'fresh_referee_verdict', store: services.store });
  const venueRubricManager = buildVenueRubricManager({ paperTask: row.task, targetProfile: targetJournalProfile, targetSelectionPolicy, roundIndex, sourceRecord: freshRefereeReview?.intake?.sourceRecord || null, refereePool: freshRefereePool });
  const journalRubricPacket = buildJournalRubricPacket({ paperTask: row.task, targetProfile: targetJournalProfile, targetSelectionPolicy, venueRubricManager, refereePool: freshRefereePool, roundIndex, sourceRecord: freshRefereeReview?.intake?.sourceRecord || null });
  const venueEvidenceGate = buildVenueEvidenceGate({ paperTask: row.task, targetProfile: targetJournalProfile, venueRubricManager, researchReport, packageResult });
  const venueLifecyclePolicy = buildVenueLifecyclePolicy({ paperTask: row.task, targetProfile: targetJournalProfile, evidenceGate: venueEvidenceGate, lifecycle });
  const freshRefereeVerdict = buildFreshRefereeVerdict({
    paperTask: row.task, targetProfile: targetJournalProfile, rubricPacket: journalRubricPacket,
    venueRubricManager, refereePool: freshRefereePool,
    independentReviewAuthorityReceipt: lifecycle.independentReviewAuthorityReceipt,
    evidenceGate: venueEvidenceGate, lifecyclePolicy: venueLifecyclePolicy,
    reviewReport: freshRefereeReview?.reviewReport || null, openIssueCount: openAfter,
    buildResult, packageResult, researchReport, lifecycle, roundIndex,
  });
  const currentReviewFindingCount = Number(freshRefereeReview?.findingCount || 0);
  const newIssueRows = Number(refereeReview?.materializedIssueCount || 0);
  const sourceMutation = Boolean(refereeRevision?.patchApplyInvocation?.safety?.sourceMutation);
  const sqliteWrite = refereeRevision?.repairStateMutationReceipt?.status === 'repair_state_mutation_recorded';
  const diagnosticClosureReady = freshRefereeVerdict.verdict === 'accept';
  const roundStatus = diagnosticClosureReady ? 'local_diagnostic_review_round_passed'
    : freshRefereeVerdict.verdict === 'revise' ? 'local_diagnostic_review_round_revise'
      : currentReviewFindingCount > 0 ? 'local_diagnostic_review_round_findings_remaining'
        : openAfter > 0 ? 'local_diagnostic_review_round_open_issues'
          : newIssueRows > 0 ? 'local_diagnostic_review_round_recheck_required' : 'local_diagnostic_review_round_blocked';
  const roundPayload = {
    kind: 'LocalDiagnosticReviewRoundReceipt', paperId: row.task.paperId, taskKey: row.task.taskKey, roundIndex, status: roundStatus,
    requestedTargetOverride: normalizedTargetOverride || null, targetOverrideApplied, originalVenueTarget: row.task.venueTarget || null, effectiveTarget: effectiveTarget || null,
    journalProfileId: targetJournalProfile.profile?.id || null, journalTargetProfileHash: targetJournalProfile.journalTargetProfileHash,
    targetSelectionPolicyHash: targetSelectionPolicy.targetSelectionPolicyHash, journalRubricPacketHash: journalRubricPacket.journalRubricPacketHash,
    venueRubricManagerHash: venueRubricManager.venueRubricManagerHash, freshRefereePoolHash: freshRefereePool.freshRefereePoolHash,
    venueEvidenceGateHash: venueEvidenceGate.venueEvidenceGateHash, venueLifecyclePolicyHash: venueLifecyclePolicy.venueLifecyclePolicyHash,
    freshRefereeId: freshRefereeVerdict.refereeId, localHeuristicVerdict: freshRefereeVerdict.verdict,
    diagnosticVerdict: freshRefereeVerdict.verdict === 'accept' ? 'pass' : 'revise', academicAcceptanceGranted: false,
    freshRefereeVerdictStatus: freshRefereeVerdict.status, freshRefereeVerdictHash: freshRefereeVerdict.freshRefereeVerdictHash,
    startedAt: roundStartedAt, completedAt: nowIso(), openIssueCountBeforeReview: openBefore,
    reviewFindingCount: Number(refereeReview?.findingCount || 0), freshRefereeFindingCount: currentReviewFindingCount,
    reviewIssueRowsInserted: newIssueRows, reviewIssueRowsAlreadyPresent: Number(refereeReview?.existingIssueCount || 0), openIssueCountAfterRevise: openAfter,
    sourceMutation, sqliteWrite, packageStatus: packageResult?.artifactPackage?.packageStatus || packageResult?.status || null,
    empiricalAnalysisStatus: empiricalAnalysis?.status || null, empiricalEvidenceGateStatus: empiricalAnalysis?.empiricalEvidenceGate?.status || null,
    empiricalApplyStatus: empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status || null,
    empiricalExperimentRunReceiptStatus: empiricalAnalysis?.experimentRunReceipt?.status || null,
    empiricalResultArtifactPackageStatus: empiricalAnalysis?.resultArtifactPackage?.status || null,
    empiricalAnalysisBlockers: empiricalAnalysis?.blockers || [], empiricalDatasetMode: empiricalAnalysis?.datasetAccessContract?.datasetMode || null,
    localBenchmarkRegistryStatus: empiricalAnalysis?.localBenchmarkRegistry?.status || null, venueEvidenceGateStatus: venueEvidenceGate.status,
    venueLifecyclePolicyStatus: venueLifecyclePolicy.status, reviewedSubmitPreflightStatus: lifecycle?.reviewedSubmitPreflightPacket?.status || null,
    controlledExecutorReceiptStatus: lifecycle?.controlledExecutorReceipt?.status || null, freshRefereeBlockers: freshRefereeVerdict.blockers,
    externalActionPerformed: false,
  };
  const roundReceipt = { ...roundPayload, localDiagnosticReviewRoundReceiptHash: hashPaperRecord('LocalDiagnosticReviewRoundReceipt', roundPayload) };
  services.receiptLedger.record(roundReceipt, { stream: 'local-diagnostic-rounds', paperId: row.task.paperId });
  return {
    refereeReview, refereeRevision, buildResult, packageResult, researchReport, empiricalAnalysis, lifecycle,
    freshRefereeReview, freshRefereeVerdict, journalRubricPacket, venueRubricManager, freshRefereePool,
    venueEvidenceGate, venueLifecyclePolicy, sourceMutation, sqliteWrite, diagnosticClosureReady, roundReceipt,
  };
}
