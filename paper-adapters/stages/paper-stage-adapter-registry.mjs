import { writeJsonFile } from '../artifacts/write-artifact.mjs';
import { runLatexBuildAdapter, runPackageAdapter } from '../build-package/index.mjs';
import { runEmpiricalAnalysisAdapter } from '../empirical-analysis/index.mjs';
import {
  buildFreshRefereePool,
  buildFreshRefereeVerdict,
  buildJournalConferenceRegistry,
  buildJournalConferenceSystemPacket,
  buildJournalRubricPacket,
  buildJournalTargetProfile,
  buildTargetSelectionPolicy,
  buildVenueEvidenceGate,
  buildVenueLifecyclePolicy,
  buildVenueRubricManager,
  runJournalManageAdapter,
} from '../journal-manage/index.mjs';
import { runRefereeReviewAdapter } from '../referee-review/index.mjs';
import { runRefereeReviseAdapter } from '../referee-revise/index.mjs';
import { runResearchVerifyAdapter } from '../research-verify/index.mjs';
import { runSourceAdaptAdapter } from '../source-adapt/index.mjs';
import { buildSubmissionLifecycle, prepareSubmissionAuthorities } from '../submission/index.mjs';
import { runVenueResolveAdapter } from '../venue-resolve/index.mjs';

// The composition root owns concrete stage adapters. Application use-cases receive this
// registry through ExecutionContext instead of importing infrastructure modules directly.
export function createPaperStageAdapterRegistry() {
  return Object.freeze({
    buildFreshRefereePool,
    buildFreshRefereeVerdict,
    buildJournalConferenceRegistry,
    buildJournalConferenceSystemPacket,
    buildJournalRubricPacket,
    buildJournalTargetProfile,
    buildSubmissionLifecycle,
    buildTargetSelectionPolicy,
    buildVenueEvidenceGate,
    buildVenueLifecyclePolicy,
    buildVenueRubricManager,
    prepareSubmissionAuthorities,
    runEmpiricalAnalysisAdapter,
    runJournalManageAdapter,
    runLatexBuildAdapter,
    runPackageAdapter,
    runRefereeReviewAdapter,
    runRefereeReviseAdapter,
    runResearchVerifyAdapter,
    runSourceAdaptAdapter,
    runVenueResolveAdapter,
    writeJsonFile,
  });
}
