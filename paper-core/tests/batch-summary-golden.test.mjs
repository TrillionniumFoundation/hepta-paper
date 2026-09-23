import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeResults } from '../../paper-application/reporting/batch-result-summary.mjs';

const TOP_LEVEL_COUNTERS = [
  'researchTypedContracts', 'legacyCatalogReferenceReceipts', 'legacyCatalogReferenceCount',
  'researchContractReady', 'researchEvidenceCandidatePresent', 'researchNativeExecutionReady',
  'researchAcademicEvidenceReady', 'nativeResearchWorkerPlans', 'nativeResearchWorkersExecuted',
  'academicEvidenceVerified', 'journalManageReports', 'journalConferenceRegistries',
  'targetSelectionPolicies', 'journalTargetProfiles', 'journalTargetProfileReady',
  'journalRubricPackets', 'journalRubricReady', 'venueRubricManagers', 'freshRefereePools',
  'venueEvidenceGates', 'venueEvidenceGateReady', 'venueLifecyclePolicies',
  'journalConferenceSystemPackets', 'empiricalAnalysisReports', 'empiricalAnalysisEvidenceReady',
  'empiricalBenchmarkRegistries', 'empiricalBenchmarkRegistriesReady',
  'benchmarkSuiteSelectionPolicies', 'benchmarkSuiteSelectionReady',
  'empiricalLocalBenchmarkRegistries', 'empiricalLocalBenchmarkRegistryReady',
  'empiricalAuthorizedLocalDatasets', 'datasetLicenseProvenanceGates',
  'datasetLicenseProvenanceGateReady', 'tableFigureSpecs', 'tableFigureSpecReady',
  'empiricalExperimentRunReceipts', 'empiricalExperimentRunRecorded',
  'empiricalResultArtifactPackages', 'empiricalEvidenceGates', 'empiricalEvidenceGateReady',
  'empiricalManuscriptPatches', 'empiricalManuscriptPatchReady',
  'empiricalManuscriptApplyApprovalPackets', 'empiricalManuscriptApplyApprovalReady',
  'empiricalManuscriptApplyPlans', 'empiricalManuscriptApplyPlanReady',
  'empiricalManuscriptApplyReceipts', 'empiricalManuscriptApplyApplied',
  'empiricalExternalActions', 'empiricalSourceMutations', 'localHeuristicVerdicts',
  'localDiagnosticPasses', 'localDiagnosticRevisions', 'refereeReviewReports',
  'refereeReviewReady', 'refereeReviewBlocked', 'refereeReviewFindings',
  'refereeIssueQueueMaterializations', 'refereeIssueQueueMaterializationPlanned',
  'refereeIssueQueueMaterialized', 'refereeIssueQueueMaterializationBlocked',
  'refereeReviewIssueRowsInserted', 'refereeReviewIssueRowsAlreadyPresent', 'refereeOpenIssues',
  'refereePreflightReady', 'refereeRollbackLedgerDrafts', 'refereePreimageSnapshotLedgers',
  'refereePreimageSnapshotReady', 'refereeExecutePlansReady', 'refereeApplyModeContracts',
  'refereeExecuteDesignPackets', 'refereeExecuteDesignReadyApplyBlocked',
  'refereeExecuteDesignReadyForApplyExecution', 'refereeApplyApprovalPackets',
  'refereeApplyApprovalBlocked', 'refereeApplyApprovalReady', 'refereeApplyAgentApproved',
  'refereePatchApplyExecutions', 'refereePatchApplyExecutionBlocked',
  'refereePatchApplyExecutionReady', 'refereePatchApplyApprovalGateBlocked',
  'refereePatchApplyInvocations', 'refereePatchApplyInvocationBlocked',
  'refereePatchApplyInvocationRequired', 'refereePatchApplyValidationBlocked',
  'refereePatchApplyInvocationApplied', 'refereeAgentRepairPatchBundles',
  'refereeAgentRepairPatchBundleReady', 'refereeAgentRepairPatchBundleAlreadyPresent',
  'refereeAgentRepairPatchBundleBlocked', 'refereeSourceMutations', 'refereeAppliedPatchReceipts',
  'refereeAppliedPatchReceiptBlocked', 'refereeAppliedPatchReceiptRecorded',
  'refereeAppliedPatchExecutionGateBlocked', 'refereeAppliedPatchInvocationGateBlocked',
  'refereePostRepairBuildPackages', 'refereePostRepairBuildPackageBlocked',
  'refereePostRepairBuildPackageReady', 'refereePostRepairBuildRecheckPassed',
  'refereePostRepairPackageRewriteReady', 'refereePostRepairResearchRecheckPassed',
  'refereePostRepairAppliedReceiptGateBlocked', 'refereeIssueResolutionProofs',
  'refereeIssueResolutionProofBlocked', 'refereeIssueResolutionProofReady',
  'refereeIssueResolutionEvidenceItems', 'refereeIssueResolutionPostRepairGateBlocked',
  'refereeRepairReconciliations', 'refereeRepairReconciliationBlocked',
  'refereeRepairReconciliationReady', 'refereeRepairReconciled',
  'refereeRepairStateMutationReceipts', 'refereeRepairStateMutationRecorded',
  'refereeRepairStateMutationBlocked', 'refereeRepairStateMutationIssueRowsUpdated',
  'refereeRepairStateMutationPatchRowsInserted', 'refereeRepairStateMutationPatchRowsUpdated',
  'refereeRepairStateMutationPatchRowsAlreadyPresent', 'refereeReviewedSubmitReadinessReleased',
  'refereeIssueStateMutations', 'refereeSqliteWrites',
  'refereeRepairReconciliationProofGateBlocked', 'refereeApplyApprovalRequired',
  'localDiagnosticReviewLoopRuns', 'localDiagnosticReviewLoopPassed',
  'localDiagnosticReviewLoopBlocked', 'localDiagnosticReviewLoopRounds',
  'localDiagnosticReviewLoopFinalOpenIssues', 'localDiagnosticReviewLoopSourceMutations',
  'localDiagnosticReviewLoopSqliteWrites', 'localDiagnosticReviewLoopReceipts',
  'localDiagnosticReviewLoopPassRecorded', 'localDiagnosticReviewLoopExternalActions',
  'lifecycleOutboxItems', 'lifecycleReconciled',
];

const SUBMISSION_COUNTERS = [
  'lifecycleItems', 'reviewedSubmitItems', 'approvalPackets', 'approvalBlocked',
  'approvalRequired', 'academicEvidenceRequired', 'independentRefereeAuthorityRequired',
  'independentRefereeAuthorityVerified', 'liveAuthorizationRequired', 'liveAuthorizationVerified',
  'approvalAgentApproved', 'reviewedSubmitPreflightPackets', 'reviewedSubmitPreflightBlocked',
  'reviewedSubmitPreflightReady', 'freshVenueEvidenceReady', 'executorOutboxItems',
  'executorOutboxBlocked', 'controlledExecutorReceipts', 'controlledExecutorReceiptRecorded',
  'controlledExecutorReceiptBlocked', 'liveExecutorBoundaryBlocked',
  'externalExecutorImplementationPresent', 'externalActionsPerformed',
];

const VENUE_COUNTERS = [
  'required', 'packets', 'manualDecisionRequired', 'waitingForLocalPackage',
  'withCandidateVenues', 'submitReadyPackagePlansRequired', 'registryAddPlansReady',
  'operatorPacketsReady', 'operatorPacketsBlocked',
];

const SOURCE_COUNTERS = [
  'required', 'packets', 'manualSourceDecisionRequired', 'mainTexCandidateReviewRequired',
  'withTexCandidates', 'pdfOnlyOrCodeProject', 'operatorPacketsReady', 'operatorPacketsBlocked',
];

const zeros = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));

function emptyGolden() {
  return {
    campaignQueue: {
      planned: 0,
      submitted: 0,
      queued: 0,
      replayed: 0,
      nodeCount: 0,
      maximumNodesPerCampaign: 0,
      workflowExecutionsPerformed: 0,
    },
    proposalStaging: { staged: 0, sourceSkeletons: 0 },
    buildArtifactAcceptance: { accepted: 0, compiledPdfArtifacts: 0 },
    ...zeros(TOP_LEVEL_COUNTERS),
    submissionPreflight: zeros(SUBMISSION_COUNTERS),
    venueResolution: zeros(VENUE_COUNTERS),
    sourceAdaptation: zeros(SOURCE_COUNTERS),
  };
}

function setPath(target, dottedPath, value) {
  const parts = dottedPath.split('.');
  const leaf = parts.pop();
  let cursor = target;
  for (const part of parts) cursor = cursor[part];
  cursor[leaf] = value;
}

function goldenWith(overrides) {
  const golden = emptyGolden();
  for (const [path, value] of overrides) setPath(golden, path, value);
  return golden;
}

const SPARSE_RESULT = {
  task: { registry: { inventorySource: 'proposal_staging' }, sourceWorkspace: '/runtime/proposals/paper' },
  buildResult: {}, packageResult: { artifactPackage: { artifacts: [] } }, researchReport: {},
  journalManagement: {}, empiricalAnalysis: {}, refereeReview: {}, refereeRevision: {},
  lifecycle: { reviewedSubmit: true, approvalPacket: { blockers: [] }, safety: {} },
  localDiagnosticReviewLoop: {}, venueResolution: {}, sourceAdaptation: {},
};

const RICH_RESULT = {
  task: { registry: { inventorySource: 'proposal_staging' }, sourceWorkspace: '/runtime/proposals/rich' },
  buildResult: { buildArtifactAcceptance: { status: 'compiled_pdf_accepted_for_local_package' } },
  packageResult: { artifactPackage: { artifacts: [{ role: 'build_artifact_acceptance' }, { role: 'compiled_pdf' }] } },
  researchReport: {
    typedContracts: { claimScopeContract: { kind: 'ClaimScopeContract' }, evidenceMatrixContract: { kind: 'EvidenceMatrixContract' } },
    legacyCatalogReferenceReceiptCount: 2, legacyCatalogReferenceCount: 7,
    nativeResearchWorkerExecution: { planHash: 'plan', status: 'native_research_workers_verified' },
    executedResearchWorkerCount: 3, verifiedNativeResearchWorkerCount: 2,
    academicEvidenceStatus: 'academic_evidence_verified', academicEvidenceEligible: true,
    sourceEvidenceCount: 4,
  },
  journalManagement: {
    kind: 'JournalManageAdapterReport', registry: { kind: 'JournalConferenceRegistry' },
    targetSelectionPolicy: { kind: 'TargetSelectionPolicy' },
    targetProfile: { kind: 'JournalTargetProfile', status: 'journal_target_profile_ready' },
    rubricPacket: { kind: 'JournalRubricPacket', status: 'journal_rubric_packet_ready' },
    venueRubricManager: { kind: 'VenueRubricManager' }, freshRefereePool: { kind: 'FreshRefereePool' },
    evidenceGate: { kind: 'VenueEvidenceGate', status: 'venue_evidence_gate_ready' },
    lifecyclePolicy: { kind: 'VenueLifecyclePolicy' }, systemPacket: { kind: 'JournalConferenceSystemPacket' },
  },
  empiricalAnalysis: {
    kind: 'EmpiricalAnalysisAdapterReport', status: 'empirical_analysis_evidence_ready',
    empiricalBenchmarkRegistry: { kind: 'EmpiricalBenchmarkRegistry', status: 'empirical_benchmark_registry_ready' },
    benchmarkSuiteSelectionPolicy: { kind: 'BenchmarkSuiteSelectionPolicy', status: 'benchmark_suite_selection_ready' },
    localBenchmarkRegistry: { kind: 'LocalBenchmarkRegistry', status: 'local_benchmark_registry_ready' },
    datasetAccessContract: { datasetMode: 'authorized_local_dataset' },
    datasetLicenseProvenanceGate: { kind: 'DatasetLicenseProvenanceGate', status: 'dataset_license_provenance_gate_ready' },
    tableFigureSpec: { kind: 'TableFigureSpec', status: 'table_figure_spec_ready' },
    experimentRunReceipt: { kind: 'ExperimentRunReceipt', status: 'experiment_run_receipt_recorded' },
    resultArtifactPackage: { kind: 'ResultArtifactPackage' },
    empiricalEvidenceGate: { kind: 'EmpiricalEvidenceGate', status: 'empirical_evidence_gate_ready' },
    manuscriptEmpiricalPatch: { kind: 'ManuscriptEmpiricalPatch', status: 'manuscript_empirical_patch_ready' },
    manuscriptEmpiricalApplyApprovalPacket: { kind: 'ManuscriptEmpiricalApplyApprovalPacket', status: 'manuscript_empirical_apply_approval_ready' },
    manuscriptEmpiricalApplyPlan: { kind: 'ManuscriptEmpiricalApplyPlan', status: 'manuscript_empirical_apply_plan_ready' },
    manuscriptEmpiricalApplyReceipt: { kind: 'ManuscriptEmpiricalApplyReceipt', status: 'manuscript_empirical_apply_applied' },
    safety: { externalActionPerformed: true, sourceMutation: true },
  },
  localDiagnosticReviewLoop: {
    kind: 'LocalDiagnosticReviewLoopReport', diagnosticClosureReached: true, roundsCompleted: 3,
    finalOpenIssueCount: 1, sourceMutationCount: 2, sqliteWriteCount: 4,
    diagnosticReceipt: { kind: 'LocalDiagnosticReviewLoopReceipt', status: 'local_diagnostic_review_pass_recorded' },
    safety: { externalActionPerformed: true }, freshRefereeVerdictCount: 5,
    diagnosticPassCount: 6, freshRefereeReviseCount: 7,
  },
  lifecycle: {
    reviewedSubmit: true, reconciliation: { status: 'dry_run_reconciled' },
    outbox: { kind: 'ExternalExecutorHandoffOutbox', status: 'blocked_outbox_item' },
    approvalPacket: {
      kind: 'SubmissionApprovalPacket', status: 'blocked_approval_packet', agentApproved: true,
      blockers: ['explicit_reviewed_submit_approval_required', 'attested_academic_evidence_required_for_reviewed_submit', 'independent_referee_acceptance_authority_required', 'live_submission_authorization_required'],
    },
    independentReviewAuthorityReceipt: { status: 'independent_referee_acceptance_verified' },
    liveAuthorizationReceipt: { status: 'live_submission_authorization_verified' },
    reviewedSubmitPreflightPacket: { kind: 'ReviewedSubmitPreflightPacket', status: 'reviewed_submit_preflight_ready_for_external_executor', liveExecutorBoundaryBlocked: true },
    freshVenueEvidenceBundle: { status: 'fresh_venue_evidence_ready' },
    controlledExecutorReceipt: { kind: 'ControlledExternalExecutorReceipt', status: 'controlled_external_executor_receipt_recorded' },
    safety: { executorImplementationPresent: true, externalActionPerformed: true },
    receipt: { externalActionPerformed: true },
  },
  venueResolution: {
    venueResolutionRequired: true, packet: { kind: 'VenueResolutionPacket', status: 'manual_venue_decision_required' },
    candidateCount: 2, submitReadyPackagePlan: { status: 'submit_ready_package_plan_required' },
    venueRegistryAddPlan: { status: 'registry_add_plan_requires_operator_target' },
    venueResolutionOperatorPacket: { status: 'venue_operator_decision_ready' },
  },
  sourceAdaptation: {
    sourceAdaptationRequired: true,
    packet: { kind: 'SourceAdaptationPacket', status: 'main_tex_candidate_review_required', texCandidateCount: 2, pdfCandidateCount: 1 },
    sourceAdaptationOperatorPacket: { status: 'main_tex_selection_ready' },
  },
};

const RICH_OVERRIDES = [
  ['proposalStaging.staged', 1], ['proposalStaging.sourceSkeletons', 1],
  ['buildArtifactAcceptance.accepted', 1], ['buildArtifactAcceptance.compiledPdfArtifacts', 1],
  ['researchTypedContracts', 1], ['legacyCatalogReferenceReceipts', 2], ['legacyCatalogReferenceCount', 7],
  ['researchContractReady', 1], ['researchEvidenceCandidatePresent', 1], ['researchNativeExecutionReady', 1],
  ['researchAcademicEvidenceReady', 1], ['nativeResearchWorkerPlans', 1], ['nativeResearchWorkersExecuted', 3],
  ['academicEvidenceVerified', 1], ['journalManageReports', 1], ['journalConferenceRegistries', 1],
  ['targetSelectionPolicies', 1], ['journalTargetProfiles', 1], ['journalTargetProfileReady', 1],
  ['journalRubricPackets', 1], ['journalRubricReady', 1], ['venueRubricManagers', 1],
  ['freshRefereePools', 1], ['venueEvidenceGates', 1], ['venueEvidenceGateReady', 1],
  ['venueLifecyclePolicies', 1], ['journalConferenceSystemPackets', 1], ['empiricalAnalysisReports', 1],
  ['empiricalAnalysisEvidenceReady', 1], ['empiricalBenchmarkRegistries', 1],
  ['empiricalBenchmarkRegistriesReady', 1], ['benchmarkSuiteSelectionPolicies', 1],
  ['benchmarkSuiteSelectionReady', 1], ['empiricalLocalBenchmarkRegistries', 1],
  ['empiricalLocalBenchmarkRegistryReady', 1], ['empiricalAuthorizedLocalDatasets', 1],
  ['datasetLicenseProvenanceGates', 1], ['datasetLicenseProvenanceGateReady', 1],
  ['tableFigureSpecs', 1], ['tableFigureSpecReady', 1], ['empiricalExperimentRunReceipts', 1],
  ['empiricalExperimentRunRecorded', 1], ['empiricalResultArtifactPackages', 1],
  ['empiricalEvidenceGates', 1], ['empiricalEvidenceGateReady', 1], ['empiricalManuscriptPatches', 1],
  ['empiricalManuscriptPatchReady', 1], ['empiricalManuscriptApplyApprovalPackets', 1],
  ['empiricalManuscriptApplyApprovalReady', 1], ['empiricalManuscriptApplyPlans', 1],
  ['empiricalManuscriptApplyPlanReady', 1], ['empiricalManuscriptApplyReceipts', 1],
  ['empiricalManuscriptApplyApplied', 1], ['empiricalExternalActions', 1], ['empiricalSourceMutations', 1],
  ['localHeuristicVerdicts', 5], ['localDiagnosticPasses', 6], ['localDiagnosticRevisions', 7],
  ['localDiagnosticReviewLoopRuns', 1], ['localDiagnosticReviewLoopPassed', 1],
  ['localDiagnosticReviewLoopRounds', 3], ['localDiagnosticReviewLoopFinalOpenIssues', 1],
  ['localDiagnosticReviewLoopSourceMutations', 2], ['localDiagnosticReviewLoopSqliteWrites', 4],
  ['localDiagnosticReviewLoopReceipts', 1], ['localDiagnosticReviewLoopPassRecorded', 1],
  ['localDiagnosticReviewLoopExternalActions', 1], ['lifecycleOutboxItems', 1], ['lifecycleReconciled', 1],
  ['submissionPreflight.lifecycleItems', 1], ['submissionPreflight.reviewedSubmitItems', 1],
  ['submissionPreflight.approvalPackets', 1], ['submissionPreflight.approvalBlocked', 1],
  ['submissionPreflight.approvalRequired', 1], ['submissionPreflight.academicEvidenceRequired', 1],
  ['submissionPreflight.independentRefereeAuthorityRequired', 1],
  ['submissionPreflight.independentRefereeAuthorityVerified', 1],
  ['submissionPreflight.liveAuthorizationRequired', 1], ['submissionPreflight.liveAuthorizationVerified', 1],
  ['submissionPreflight.approvalAgentApproved', 1], ['submissionPreflight.reviewedSubmitPreflightPackets', 1],
  ['submissionPreflight.reviewedSubmitPreflightReady', 1], ['submissionPreflight.freshVenueEvidenceReady', 1],
  ['submissionPreflight.executorOutboxItems', 1], ['submissionPreflight.executorOutboxBlocked', 1],
  ['submissionPreflight.controlledExecutorReceipts', 1],
  ['submissionPreflight.controlledExecutorReceiptRecorded', 1],
  ['submissionPreflight.liveExecutorBoundaryBlocked', 1],
  ['submissionPreflight.externalExecutorImplementationPresent', 1],
  ['submissionPreflight.externalActionsPerformed', 1], ['venueResolution.required', 1],
  ['venueResolution.packets', 1], ['venueResolution.manualDecisionRequired', 1],
  ['venueResolution.withCandidateVenues', 1], ['venueResolution.submitReadyPackagePlansRequired', 1],
  ['venueResolution.registryAddPlansReady', 1], ['venueResolution.operatorPacketsReady', 1],
  ['sourceAdaptation.required', 1], ['sourceAdaptation.packets', 1],
  ['sourceAdaptation.mainTexCandidateReviewRequired', 1], ['sourceAdaptation.withTexCandidates', 1],
  ['sourceAdaptation.operatorPacketsReady', 1],
];

test('batch summary empty fixture matches the complete golden output', () => {
  assert.deepEqual(summarizeResults([]), emptyGolden());
});

test('batch summary sparse fixture matches the complete golden output', () => {
  assert.deepEqual(summarizeResults([SPARSE_RESULT]), goldenWith([
    ['proposalStaging.staged', 1], ['proposalStaging.sourceSkeletons', 1],
    ['submissionPreflight.lifecycleItems', 1], ['submissionPreflight.reviewedSubmitItems', 1],
  ]));
});

test('batch summary rich fixture matches the complete golden output', () => {
  assert.deepEqual(summarizeResults([RICH_RESULT]), goldenWith(RICH_OVERRIDES));
});

test('metric descriptors traverse the source result array exactly once', () => {
  let iteratorCount = 0;
  const source = new Proxy([SPARSE_RESULT, RICH_RESULT], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) iteratorCount += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  summarizeResults(source);
  assert.equal(iteratorCount, 1);
});
