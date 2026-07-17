import { writeJsonFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import { runLatexBuildAdapter, runPackageAdapter } from '../../paper-adapters/build-package/index.mjs';
import { runEmpiricalAnalysisAdapter } from '../../paper-adapters/empirical-analysis/index.mjs';
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
} from '../../paper-adapters/journal-manage/index.mjs';
import { runRefereeReviewAdapter } from '../../paper-adapters/referee-review/index.mjs';
import { runRefereeReviseAdapter } from '../../paper-adapters/referee-revise/index.mjs';
import { runResearchVerifyAdapter } from '../../paper-adapters/research-verify/index.mjs';
import { runSourceAdaptAdapter } from '../../paper-adapters/source-adapt/index.mjs';
import { buildSubmissionLifecycle, prepareSubmissionAuthorities } from '../../paper-adapters/submission/index.mjs';
import { runVenueResolveAdapter } from '../../paper-adapters/venue-resolve/index.mjs';
import { composeLegacyStagePorts } from './legacy-stage-port-composition.mjs';

// Concrete all-stage registries belong only to this compatibility composition.
// Production campaign roots receive capability-specific ports instead.
export function createLegacyPaperStageAdapterRegistry({ includeSubmission = true } = {}) {
  const adapters = {
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
  };
  if (includeSubmission) {
    adapters.buildSubmissionLifecycle = buildSubmissionLifecycle;
    adapters.prepareSubmissionAuthorities = prepareSubmissionAuthorities;
  }
  return Object.freeze(adapters);
}

export function composeCompatibilityStagePorts({
  includeSubmission = false,
  store,
  campaignReleaseAuthorityRepository = null,
} = {}) {
  return composeLegacyStagePorts({
    registry: createLegacyPaperStageAdapterRegistry({ includeSubmission }),
    store,
    campaignReleaseAuthorityRepository,
    includeSubmission,
  });
}
