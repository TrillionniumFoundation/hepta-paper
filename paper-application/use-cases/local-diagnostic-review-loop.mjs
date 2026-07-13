import path from 'node:path';
import { ensureDir } from '../../workflow-kernel/runtime/file-utils.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { writeJsonFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import {
  buildJournalConferenceRegistry, buildJournalConferenceSystemPacket, buildJournalTargetProfile, buildTargetSelectionPolicy,
} from '../../paper-adapters/journal-manage/index.mjs';
import { executeLocalDiagnosticRound } from './local-diagnostic-round-executor.mjs';

export async function runLocalDiagnosticReviewLoop({
  root, runtimeRoot, services, row, venues = [], execute = false, maxRounds = 6,
  targetOverride = null, datasetRoot = null, benchmarkId = null, applyManuscript = false,
} = {}) {
  if (!services?.store || !services?.receiptLedger) throw new Error('Local diagnostic loop requires ExecutionContext services');
  const roundLimit = Math.max(1, Math.min(20, Number(maxRounds) || 6));
  const minimumFreshRefereeRounds = 1;
  const normalizedTargetOverride = normalizeText(targetOverride || '');
  const effectiveTarget = normalizedTargetOverride || row.task.venueTarget || '';
  const targetOverrideApplied = Boolean(normalizedTargetOverride);
  const journalConferenceRegistry = buildJournalConferenceRegistry();
  const targetSelectionPolicy = buildTargetSelectionPolicy({ paperTask: row.task, target: effectiveTarget, hints: [row.task.title, row.task.paperType, row.task.paperId], registry: journalConferenceRegistry });
  const targetJournalProfile = buildJournalTargetProfile({ paperTask: row.task, target: effectiveTarget, registry: journalConferenceRegistry, targetSelectionPolicy, hints: [row.task.title, row.task.paperType, row.task.paperId] });
  const rounds = [];
  let diagnosticClosureReached = false;
  let final = null;
  let sourceMutationCount = 0;
  let sqliteWriteCount = 0;
  let diagnosticPassCount = 0;
  let freshRefereeReviseCount = 0;

  for (let roundIndex = 1; roundIndex <= roundLimit; roundIndex += 1) {
    const round = await executeLocalDiagnosticRound({
      root, runtimeRoot, services, row, venues, execute, roundIndex, effectiveTarget,
      normalizedTargetOverride, targetOverrideApplied, targetJournalProfile, targetSelectionPolicy,
      datasetRoot, benchmarkId, applyManuscript,
    });
    rounds.push(round.roundReceipt);
    final = round;
    sourceMutationCount += round.sourceMutation ? 1 : 0;
    sqliteWriteCount += round.sqliteWrite ? 1 : 0;
    diagnosticPassCount += round.freshRefereeVerdict?.verdict === 'accept' ? 1 : 0;
    freshRefereeReviseCount += round.freshRefereeVerdict?.verdict === 'revise' ? 1 : 0;
    if (round.diagnosticClosureReady && roundIndex >= minimumFreshRefereeRounds) {
      diagnosticClosureReached = true;
      break;
    }
  }

  const finalOpenIssueCount = Number(final?.roundReceipt?.openIssueCountAfterRevise || 0);
  const journalConferenceSystemPacket = buildJournalConferenceSystemPacket({
    paperTask: row.task, registry: journalConferenceRegistry, targetSelectionPolicy,
    targetProfile: targetJournalProfile, rubricPacket: final?.journalRubricPacket,
    venueRubricManager: final?.venueRubricManager, freshRefereePool: final?.freshRefereePool,
    evidenceGate: final?.venueEvidenceGate, lifecyclePolicy: final?.venueLifecyclePolicy,
  });
  const blockers = [];
  if (!diagnosticClosureReached) {
    blockers.push(finalOpenIssueCount > 0 ? 'local_diagnostic_review_open_issues_after_max_rounds' : 'local_diagnostic_review_pass_not_reached_before_max_rounds');
    blockers.push(...(final?.freshRefereeVerdict?.blockers || []));
  }
  const diagnosticPayload = {
    kind: 'LocalDiagnosticReviewLoopReceipt', paperId: row.task.paperId, taskKey: row.task.taskKey,
    status: diagnosticClosureReached ? 'local_diagnostic_review_pass_recorded' : 'local_diagnostic_review_blocked',
    diagnosticClosureReached, academicAcceptanceGranted: false, diagnosticActor: 'local-deterministic-review-loop',
    roundsCompleted: rounds.length, maxRounds: roundLimit, minimumFreshRefereeRounds,
    journalConferenceRegistryHash: journalConferenceRegistry.journalConferenceRegistryHash,
    targetSelectionPolicyHash: targetSelectionPolicy.targetSelectionPolicyHash,
    journalProfileId: targetJournalProfile.profile?.id || null, journalTargetProfileHash: targetJournalProfile.journalTargetProfileHash,
    finalJournalRubricPacketHash: final?.journalRubricPacket?.journalRubricPacketHash || null,
    finalVenueRubricManagerHash: final?.venueRubricManager?.venueRubricManagerHash || null,
    finalFreshRefereePoolHash: final?.freshRefereePool?.freshRefereePoolHash || null,
    finalVenueEvidenceGateHash: final?.venueEvidenceGate?.venueEvidenceGateHash || null,
    finalVenueLifecyclePolicyHash: final?.venueLifecyclePolicy?.venueLifecyclePolicyHash || null,
    journalConferenceSystemPacketHash: journalConferenceSystemPacket.journalConferenceSystemPacketHash,
    finalFreshRefereeVerdict: final?.freshRefereeVerdict?.verdict || null,
    finalFreshRefereeVerdictStatus: final?.freshRefereeVerdict?.status || null,
    finalFreshRefereeVerdictHash: final?.freshRefereeVerdict?.freshRefereeVerdictHash || null,
    finalFreshRefereeId: final?.freshRefereeVerdict?.refereeId || null, finalOpenIssueCount,
    requestedTargetOverride: normalizedTargetOverride || null, targetOverrideApplied,
    originalVenueTarget: row.task.venueTarget || null, effectiveTarget: normalizeText(effectiveTarget) || null,
    finalReviewStatus: final?.freshRefereeReview?.reviewReport?.status || null,
    finalReviewFindingCount: Number(final?.freshRefereeReview?.findingCount || 0),
    finalReviewIssueRowsInserted: Number(final?.refereeReview?.materializedIssueCount || 0),
    finalReviewedSubmitPreflightStatus: final?.lifecycle?.reviewedSubmitPreflightPacket?.status || null,
    finalControlledExecutorReceiptStatus: final?.lifecycle?.controlledExecutorReceipt?.status || null,
    blockers: [...new Set(blockers)],
    safety: { sourceMutation: sourceMutationCount > 0, sqliteWrites: sqliteWriteCount > 0, externalActionPerformed: false, liveExternalSubmissionPerformed: false, targetOverrideRuntimeOnly: targetOverrideApplied, writesLegacyRegistry: false },
  };
  const diagnosticReceipt = { ...diagnosticPayload, localDiagnosticReviewLoopReceiptHash: hashPaperRecord('LocalDiagnosticReviewLoopReceipt', diagnosticPayload) };
  services.receiptLedger.record(diagnosticReceipt, { stream: 'local-diagnostic-loop', paperId: row.task.paperId });
  if (runtimeRoot && rounds.length) {
    const loopDir = path.join(runtimeRoot, 'local-review-loop', row.task.paperId);
    await ensureDir(loopDir);
    await writeJsonFile(path.join(loopDir, 'LOCAL_DIAGNOSTIC_REVIEW_ROUNDS.json'), rounds, { scopeRoot: loopDir, role: 'local_diagnostic_rounds' });
    await writeJsonFile(path.join(loopDir, 'LOCAL_DIAGNOSTIC_REVIEW_RECEIPT.json'), diagnosticReceipt, { scopeRoot: loopDir, role: 'local_diagnostic_receipt' });
  }
  const report = {
    version: 1, kind: 'LocalDiagnosticReviewLoopReport', paperId: row.task.paperId, taskKey: row.task.taskKey,
    status: diagnosticClosureReached ? 'local_diagnostic_review_passed' : 'local_diagnostic_review_blocked',
    diagnosticClosureReached, academicAcceptanceGranted: false, roundsCompleted: rounds.length, maxRounds: roundLimit,
    minimumFreshRefereeRounds, finalOpenIssueCount, requestedTargetOverride: normalizedTargetOverride || null,
    targetOverrideApplied, originalVenueTarget: row.task.venueTarget || null, effectiveTarget: normalizeText(effectiveTarget) || null,
    targetJournalProfile, journalConferenceRegistry, targetSelectionPolicy,
    finalJournalRubricPacket: final?.journalRubricPacket || null, finalVenueRubricManager: final?.venueRubricManager || null,
    finalFreshRefereePool: final?.freshRefereePool || null, finalVenueEvidenceGate: final?.venueEvidenceGate || null,
    finalVenueLifecyclePolicy: final?.venueLifecyclePolicy || null, journalConferenceSystemPacket,
    finalFreshRefereeReview: final?.freshRefereeReview || null, finalFreshRefereeVerdict: final?.freshRefereeVerdict || null,
    freshRefereeVerdictCount: rounds.length, diagnosticPassCount, freshRefereeReviseCount, sourceMutationCount, sqliteWriteCount,
    rounds, finalRefereeReview: final?.refereeReview || null, finalRefereeRevision: final?.refereeRevision || null,
    finalBuildResult: final?.buildResult || null, finalPackageResult: final?.packageResult || null,
    finalResearchReport: final?.researchReport || null, finalEmpiricalAnalysis: final?.empiricalAnalysis || null,
    finalLifecycle: final?.lifecycle || null, diagnosticReceipt, blockers: [...new Set(blockers)],
    safety: { sourceMutation: sourceMutationCount > 0, sqliteWrites: sqliteWriteCount > 0, externalActionPerformed: false, liveExternalSubmissionPerformed: false, importsOldControlPlane: false, targetOverrideRuntimeOnly: targetOverrideApplied, writesLegacyRegistry: false },
  };
  return { ...report, localDiagnosticReviewLoopReportHash: hashPaperRecord('LocalDiagnosticReviewLoopReport', report) };
}
