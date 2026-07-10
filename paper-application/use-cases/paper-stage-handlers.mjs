import { runLatexBuildAdapter, runPackageAdapter } from '../../paper-adapters/build-package/index.mjs';
import { runEmpiricalAnalysisAdapter } from '../../paper-adapters/empirical-analysis/index.mjs';
import { runJournalManageAdapter } from '../../paper-adapters/journal-manage/index.mjs';
import { runRefereeReviewAdapter } from '../../paper-adapters/referee-review/index.mjs';
import { runRefereeReviseAdapter } from '../../paper-adapters/referee-revise/index.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import { runSourceAdaptAdapter } from '../../paper-adapters/source-adapt/index.mjs';
import { buildSubmissionLifecycle, prepareSubmissionAuthorities } from '../../paper-adapters/submission/index.mjs';
import { runVenueResolveAdapter } from '../../paper-adapters/venue-resolve/index.mjs';
import { PAPER_BATCH_MODES } from '../../paper-core/src/mode-registry.mjs';

export function createPaperStageHandlers({
  context,
  row,
  venues = [],
  runLocalDiagnosticReviewLoop,
} = {}) {
  const { root, runtimeRoot, mode, execute, options, services } = context;
  const { maxRounds, targetOverride, datasetRoot, benchmarkId, applyManuscript } = options;
  return Object.freeze({
    'local-review-loop': async () => {
      const localReviewLoopMode = [PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP, PAPER_BATCH_MODES.REFEREE_AUTOPILOT].includes(mode);
      const journalManagement = await runJournalManageAdapter({ root, runtimeRoot, row, target: targetOverride, execute: execute && localReviewLoopMode });
      const localDiagnosticReviewLoop = await runLocalDiagnosticReviewLoop({
        root, runtimeRoot, store: services.store, row, venues,
        execute: execute && localReviewLoopMode,
        maxRounds, targetOverride, datasetRoot, benchmarkId, applyManuscript,
        authorityVerifier: services.authorityVerifier,
        submissionDeliveryStore: services.submissionDeliveryStore,
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
      journalManagement: await runJournalManageAdapter({ root, runtimeRoot, row, target: targetOverride, execute: execute && mode === PAPER_BATCH_MODES.JOURNAL_MANAGE }),
    }),
    'empirical-analysis': async () => {
      const journalManagement = await runJournalManageAdapter({ root, runtimeRoot, row, target: targetOverride, execute: execute && mode === PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS });
      const empiricalAnalysis = await runEmpiricalAnalysisAdapter({ root, runtimeRoot, row, targetProfile: journalManagement?.targetProfile || null, targetSelectionPolicy: journalManagement?.targetSelectionPolicy || null, datasetRoot, benchmarkId, applyManuscript, execute: execute && mode === PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS });
      let buildResult = null;
      let packageResult = null;
      if (empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied') {
        buildResult = await runLatexBuildAdapter({ root, row, runtimeRoot, execute });
        packageResult = await runPackageAdapter({ root, row, buildResult, runtimeRoot, execute, store: services.store });
      }
      const researchReport = await runResearchVerifyAdapter({ root, row, runtimeRoot, authorityVerifier: services.authorityVerifier });
      return { journalManagement, empiricalAnalysis, buildResult, packageResult, researchReport };
    },
    build: async () => ({ buildResult: await runLatexBuildAdapter({ root, row, runtimeRoot, execute: execute && mode === PAPER_BATCH_MODES.LOCAL_BUILD }) }),
    package: async ({ state }) => ({ packageResult: await runPackageAdapter({ root, row, buildResult: state.buildResult, runtimeRoot, execute: execute && mode === PAPER_BATCH_MODES.LOCAL_PACKAGE, store: services.store }) }),
    'research-verify': async () => ({ researchReport: await runResearchVerifyAdapter({ root, row, runtimeRoot, executeResearchWorkers: execute && mode === PAPER_BATCH_MODES.RESEARCH_VERIFY, requireNativeWorkers: mode === PAPER_BATCH_MODES.RESEARCH_VERIFY, authorityVerifier: services.authorityVerifier, jobReceiptStore: services.jobReceiptStore, artifactRepositoryFactory: services.artifactRepositoryFactory }) }),
    'referee-review': async () => ({ refereeReview: await runRefereeReviewAdapter({ root, runtimeRoot, row, execute: execute && mode === PAPER_BATCH_MODES.REFEREE_REVIEW, store: services.store }) }),
    'referee-revise': async () => ({ refereeRevision: await runRefereeReviseAdapter({ root, runtimeRoot, row, mode: 'dry-run', execute: execute && mode === PAPER_BATCH_MODES.REFEREE_REVISE, store: services.store }) }),
    'venue-resolve': async ({ state }) => ({ venueResolution: await runVenueResolveAdapter({ row, venues, packageResult: state.packageResult }) }),
    'source-adapt': async () => ({ sourceAdaptation: await runSourceAdaptAdapter({ root, row }) }),
    submission: async ({ state }) => {
      const submissionIntent = row.submissionIntent || row.task.registry?.submissionIntent;
      if (submissionIntent && submissionIntent.status !== 'submission_candidate') return { lifecycle: null };
      const authorities = await prepareSubmissionAuthorities({ root, runtimeRoot, row, venues, artifactPackage: state.packageResult?.artifactPackage || null, researchReport: state.researchReport, mode, authorityVerifier: services.authorityVerifier });
      return { lifecycle: buildSubmissionLifecycle({ row, venues, artifactPackage: state.packageResult?.artifactPackage || null, researchReport: state.researchReport, mode, reviewedSubmit: mode === PAPER_BATCH_MODES.REVIEWED_SUBMIT, venuePlanOverride: authorities.venuePlan, independentReviewAuthorityReceipt: authorities.independentReviewAuthorityReceipt, liveAuthorizationReceipt: authorities.liveAuthorizationReceipt, deliveryStore: services.submissionDeliveryStore }) };
    },
  });
}
