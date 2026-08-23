import path from 'node:path';
import { assertJournalPolicyPort } from '../../paper-ports/journal-policy-port.mjs';
import { assertPaperStageExecutionPort } from '../../paper-ports/paper-stage-execution-port.mjs';

function bindStore(operation, store, extra = {}) {
  return (options = {}) => operation({ ...options, store, ...extra });
}

function packageWriterSelector(options, runtimeRoot, operationId) {
  const root = path.resolve(String(runtimeRoot || ''));
  const paperId = String(options?.row?.task?.paperId || '');
  const packagePath = path.resolve(String(
    options?.packageOutputDir || path.join(root, 'packages', paperId),
  ));
  if (!paperId || path.dirname(packagePath) !== path.join(root, 'packages')) {
    throw new Error('legacy_package_writer_target_invalid');
  }
  return Object.freeze({ packagePath, operationId });
}

function bindPackageWriter({
  operation,
  store,
  runtimeRoot,
  writerBoundary,
  operationId,
  extra = {},
}) {
  return async (options = {}) => {
    const invoke = () => operation({
      ...options,
      ...(runtimeRoot ? { runtimeRoot } : {}),
      store,
      ...extra,
    });
    if (options.execute !== true) return invoke();
    if (typeof writerBoundary?.runAsync !== 'function') {
      throw new Error('legacy_package_writer_boundary_required');
    }
    const selector = packageWriterSelector(options, runtimeRoot, operationId);
    return writerBoundary.runAsync(selector, async () => invoke());
  };
}

export function composeLegacyStagePorts({
  registry,
  store,
  campaignReleaseAuthorityRepository,
  includeSubmission = true,
  runtimeRoot = null,
  packageDeletionWriterBoundary = null,
  packageDeletionWriterOperationId = null,
} = {}) {
  if (!registry || !store) throw new Error('legacy stage compatibility composition requires registry and StorePort');
  const stageExecution = {
    version: 1,
    kind: 'LegacyPaperStageExecutionCompatibilityAdapter',
    empiricalAnalysis: registry.runEmpiricalAnalysisAdapter,
    journalManage: registry.runJournalManageAdapter,
    latexBuild: registry.runLatexBuildAdapter,
    packageArtifacts: bindPackageWriter({
      operation: registry.runPackageAdapter,
      store,
      runtimeRoot,
      writerBoundary: packageDeletionWriterBoundary,
      operationId: packageDeletionWriterOperationId,
    }),
    refereeReview: bindStore(registry.runRefereeReviewAdapter, store),
    refereeRevise: bindPackageWriter({
      operation: registry.runRefereeReviseAdapter,
      store,
      runtimeRoot,
      writerBoundary: packageDeletionWriterBoundary,
      operationId: packageDeletionWriterOperationId,
      extra: {
        postRepairPackageAdapter: (options = {}) =>
          registry.runPackageAdapter({ ...options, store }),
      },
    }),
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
