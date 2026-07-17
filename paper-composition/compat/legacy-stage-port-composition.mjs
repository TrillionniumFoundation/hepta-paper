import { assertJournalPolicyPort } from '../../paper-ports/journal-policy-port.mjs';
import { assertPaperStageExecutionPort } from '../../paper-ports/paper-stage-execution-port.mjs';

function bindStore(operation, store, extra = {}) {
  return (options = {}) => operation({ ...options, store, ...extra });
}

export function composeLegacyStagePorts({
  registry,
  store,
  campaignReleaseAuthorityRepository,
  includeSubmission = true,
} = {}) {
  if (!registry || !store) throw new Error('legacy stage compatibility composition requires registry and StorePort');
  const stageExecution = {
    version: 1,
    kind: 'LegacyPaperStageExecutionCompatibilityAdapter',
    empiricalAnalysis: registry.runEmpiricalAnalysisAdapter,
    journalManage: registry.runJournalManageAdapter,
    latexBuild: registry.runLatexBuildAdapter,
    packageArtifacts: bindStore(registry.runPackageAdapter, store),
    refereeReview: bindStore(registry.runRefereeReviewAdapter, store),
    refereeRevise: bindStore(registry.runRefereeReviseAdapter, store),
    researchVerify: bindStore(registry.runResearchVerifyAdapter, store),
    sourceAdapt: registry.runSourceAdaptAdapter,
    venueResolve: registry.runVenueResolveAdapter,
    ...(includeSubmission ? {
      buildSubmissionLifecycle: registry.buildSubmissionLifecycle,
      prepareSubmissionAuthorities: bindStore(registry.prepareSubmissionAuthorities, store, { campaignReleaseAuthorityRepository }),
    } : {}),
  };
  const journalPolicy = assertJournalPolicyPort({
    version: 1,
    kind: 'LegacyJournalPolicyCompatibilityAdapter',
    freshRefereePool: registry.buildFreshRefereePool,
    freshRefereeVerdict: registry.buildFreshRefereeVerdict,
    journalConferenceRegistry: registry.buildJournalConferenceRegistry,
    journalConferenceSystemPacket: registry.buildJournalConferenceSystemPacket,
    journalRubricPacket: registry.buildJournalRubricPacket,
    journalTargetProfile: registry.buildJournalTargetProfile,
    targetSelectionPolicy: registry.buildTargetSelectionPolicy,
    venueEvidenceGate: registry.buildVenueEvidenceGate,
    venueLifecyclePolicy: registry.buildVenueLifecyclePolicy,
    venueRubricManager: registry.buildVenueRubricManager,
  });
  return Object.freeze({
    stageExecution: Object.freeze(assertPaperStageExecutionPort(stageExecution, { requireSubmission: includeSubmission })),
    journalPolicy: Object.freeze(journalPolicy),
  });
}
