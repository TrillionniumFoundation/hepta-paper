import { summarizeWorkflowResults } from './workflow-result-summary.mjs';
import { summarizeCampaignResults } from './campaign-result-summary.mjs';
import {
  createResultMetricCollector,
  registerResultMetricTable,
  resultMetric,
} from './metric-descriptor-collector.mjs';

const { count, max, reduce } = resultMetric;

const BATCH_METRICS = Object.freeze({
  buildArtifactAcceptance: {
    accepted: count((result) => (
      result.buildResult?.buildArtifactAcceptance?.status === 'compiled_pdf_accepted_for_local_package'
      || (result.packageResult?.artifactPackage?.artifacts || []).some((artifact) => artifact.role === 'build_artifact_acceptance')
    )),
    compiledPdfArtifacts: count((result) => (
      (result.packageResult?.artifactPackage?.artifacts || []).some((artifact) => artifact.role === 'compiled_pdf')
    )),
  },
  researchTypedContracts: reduce((count, result) => (
    count + (result.researchReport?.typedContracts ? 1 : 0)
  ), 0),
  legacyCatalogReferenceReceipts: reduce((count, result) => (
    count + Number(result.researchReport?.legacyCatalogReferenceReceiptCount || 0)
  ), 0),
  legacyCatalogReferenceCount: max((result) => (
    Number(result.researchReport?.legacyCatalogReferenceCount || 0)
  ), 0),
  nativeResearchWorkerPlans: count((result) => (
    result.researchReport?.nativeResearchWorkerExecution?.planHash
  )),
  nativeResearchWorkersExecuted: reduce((count, result) => (
    count + Number(result.researchReport?.executedResearchWorkerCount || 0)
  ), 0),
  academicEvidenceVerified: count((result) => (
    result.researchReport?.academicEvidenceStatus === 'academic_evidence_verified'
    && result.researchReport?.academicEvidenceEligible === true
  )),
  researchContractReady: count((result) => (
    result.researchReport?.typedContracts?.claimScopeContract?.kind === 'ClaimScopeContract'
    && result.researchReport?.typedContracts?.evidenceMatrixContract?.kind === 'EvidenceMatrixContract'
  )),
  researchEvidenceCandidatePresent: count((result) => (
    Number(result.researchReport?.sourceEvidenceCount || 0) > 0
    || Number(result.researchReport?.logEvidenceCount || 0) > 0
  )),
  researchNativeExecutionReady: count((result) => (
    result.researchReport?.nativeResearchWorkerExecution?.status === 'native_research_workers_verified'
    && Number(result.researchReport?.verifiedNativeResearchWorkerCount || 0) > 0
  )),
  journalManageReports: count((result) => (
    result.journalManagement?.kind === 'JournalManageAdapterReport'
  )),
  journalConferenceRegistries: count((result) => (
    result.journalManagement?.registry?.kind === 'JournalConferenceRegistry'
    || result.localDiagnosticReviewLoop?.journalConferenceRegistry?.kind === 'JournalConferenceRegistry'
  )),
  targetSelectionPolicies: count((result) => (
    result.journalManagement?.targetSelectionPolicy?.kind === 'TargetSelectionPolicy'
    || result.localDiagnosticReviewLoop?.targetSelectionPolicy?.kind === 'TargetSelectionPolicy'
  )),
  journalTargetProfiles: count((result) => (
    result.journalManagement?.targetProfile?.kind === 'JournalTargetProfile'
    || result.localDiagnosticReviewLoop?.targetJournalProfile?.kind === 'JournalTargetProfile'
  )),
  journalTargetProfileReady: count((result) => (
    result.journalManagement?.targetProfile?.status === 'journal_target_profile_ready'
    || result.localDiagnosticReviewLoop?.targetJournalProfile?.status === 'journal_target_profile_ready'
  )),
  journalRubricPackets: count((result) => (
    result.journalManagement?.rubricPacket?.kind === 'JournalRubricPacket'
    || result.localDiagnosticReviewLoop?.finalJournalRubricPacket?.kind === 'JournalRubricPacket'
  )),
  journalRubricReady: count((result) => (
    result.journalManagement?.rubricPacket?.status === 'journal_rubric_packet_ready'
    || result.localDiagnosticReviewLoop?.finalJournalRubricPacket?.status === 'journal_rubric_packet_ready'
  )),
  venueRubricManagers: count((result) => (
    result.journalManagement?.venueRubricManager?.kind === 'VenueRubricManager'
    || result.localDiagnosticReviewLoop?.finalVenueRubricManager?.kind === 'VenueRubricManager'
  )),
  freshRefereePools: count((result) => (
    result.journalManagement?.freshRefereePool?.kind === 'FreshRefereePool'
    || result.localDiagnosticReviewLoop?.finalFreshRefereePool?.kind === 'FreshRefereePool'
  )),
  venueEvidenceGates: count((result) => (
    result.journalManagement?.evidenceGate?.kind === 'VenueEvidenceGate'
    || result.localDiagnosticReviewLoop?.finalVenueEvidenceGate?.kind === 'VenueEvidenceGate'
  )),
  venueEvidenceGateReady: count((result) => (
    result.journalManagement?.evidenceGate?.status === 'venue_evidence_gate_ready'
    || result.localDiagnosticReviewLoop?.finalVenueEvidenceGate?.status === 'venue_evidence_gate_ready'
  )),
  venueLifecyclePolicies: count((result) => (
    result.journalManagement?.lifecyclePolicy?.kind === 'VenueLifecyclePolicy'
    || result.localDiagnosticReviewLoop?.finalVenueLifecyclePolicy?.kind === 'VenueLifecyclePolicy'
  )),
  journalConferenceSystemPackets: count((result) => (
    result.journalManagement?.systemPacket?.kind === 'JournalConferenceSystemPacket'
    || result.localDiagnosticReviewLoop?.journalConferenceSystemPacket?.kind === 'JournalConferenceSystemPacket'
  )),
  empiricalAnalysisReports: count((result) => (
    result.empiricalAnalysis?.kind === 'EmpiricalAnalysisAdapterReport'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.kind === 'EmpiricalAnalysisAdapterReport'
  )),
  empiricalAnalysisEvidenceReady: count((result) => (
    result.empiricalAnalysis?.status === 'empirical_analysis_evidence_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.status === 'empirical_analysis_evidence_ready'
  )),
  empiricalBenchmarkRegistries: count((result) => (
    result.empiricalAnalysis?.empiricalBenchmarkRegistry?.kind === 'EmpiricalBenchmarkRegistry'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.empiricalBenchmarkRegistry?.kind === 'EmpiricalBenchmarkRegistry'
  )),
  empiricalBenchmarkRegistriesReady: count((result) => (
    result.empiricalAnalysis?.empiricalBenchmarkRegistry?.status === 'empirical_benchmark_registry_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.empiricalBenchmarkRegistry?.status === 'empirical_benchmark_registry_ready'
  )),
  benchmarkSuiteSelectionPolicies: count((result) => (
    result.empiricalAnalysis?.benchmarkSuiteSelectionPolicy?.kind === 'BenchmarkSuiteSelectionPolicy'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.benchmarkSuiteSelectionPolicy?.kind === 'BenchmarkSuiteSelectionPolicy'
  )),
  benchmarkSuiteSelectionReady: count((result) => (
    result.empiricalAnalysis?.benchmarkSuiteSelectionPolicy?.status === 'benchmark_suite_selection_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.benchmarkSuiteSelectionPolicy?.status === 'benchmark_suite_selection_ready'
  )),
  empiricalLocalBenchmarkRegistries: count((result) => (
    result.empiricalAnalysis?.localBenchmarkRegistry?.kind === 'LocalBenchmarkRegistry'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.localBenchmarkRegistry?.kind === 'LocalBenchmarkRegistry'
  )),
  empiricalLocalBenchmarkRegistryReady: count((result) => (
    result.empiricalAnalysis?.localBenchmarkRegistry?.status === 'local_benchmark_registry_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.localBenchmarkRegistry?.status === 'local_benchmark_registry_ready'
  )),
  empiricalAuthorizedLocalDatasets: count((result) => (
    result.empiricalAnalysis?.datasetAccessContract?.datasetMode === 'authorized_local_dataset'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.datasetAccessContract?.datasetMode === 'authorized_local_dataset'
  )),
  datasetLicenseProvenanceGates: count((result) => (
    result.empiricalAnalysis?.datasetLicenseProvenanceGate?.kind === 'DatasetLicenseProvenanceGate'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.datasetLicenseProvenanceGate?.kind === 'DatasetLicenseProvenanceGate'
  )),
  datasetLicenseProvenanceGateReady: count((result) => (
    result.empiricalAnalysis?.datasetLicenseProvenanceGate?.status === 'dataset_license_provenance_gate_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.datasetLicenseProvenanceGate?.status === 'dataset_license_provenance_gate_ready'
  )),
  tableFigureSpecs: count((result) => (
    result.empiricalAnalysis?.tableFigureSpec?.kind === 'TableFigureSpec'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.tableFigureSpec?.kind === 'TableFigureSpec'
  )),
  tableFigureSpecReady: count((result) => (
    result.empiricalAnalysis?.tableFigureSpec?.status === 'table_figure_spec_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.tableFigureSpec?.status === 'table_figure_spec_ready'
  )),
  empiricalExperimentRunReceipts: count((result) => (
    result.empiricalAnalysis?.experimentRunReceipt?.kind === 'ExperimentRunReceipt'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.experimentRunReceipt?.kind === 'ExperimentRunReceipt'
  )),
  empiricalExperimentRunRecorded: count((result) => (
    result.empiricalAnalysis?.experimentRunReceipt?.status === 'experiment_run_receipt_recorded'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.experimentRunReceipt?.status === 'experiment_run_receipt_recorded'
  )),
  empiricalResultArtifactPackages: count((result) => (
    result.empiricalAnalysis?.resultArtifactPackage?.kind === 'ResultArtifactPackage'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.resultArtifactPackage?.kind === 'ResultArtifactPackage'
  )),
  empiricalEvidenceGates: count((result) => (
    result.empiricalAnalysis?.empiricalEvidenceGate?.kind === 'EmpiricalEvidenceGate'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.empiricalEvidenceGate?.kind === 'EmpiricalEvidenceGate'
  )),
  empiricalEvidenceGateReady: count((result) => (
    result.empiricalAnalysis?.empiricalEvidenceGate?.status === 'empirical_evidence_gate_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.empiricalEvidenceGate?.status === 'empirical_evidence_gate_ready'
  )),
  empiricalManuscriptPatches: count((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalPatch?.kind === 'ManuscriptEmpiricalPatch'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalPatch?.kind === 'ManuscriptEmpiricalPatch'
  )),
  empiricalManuscriptPatchReady: count((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalPatch?.status === 'manuscript_empirical_patch_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalPatch?.status === 'manuscript_empirical_patch_ready'
  )),
  empiricalManuscriptApplyApprovalPackets: count((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.kind === 'ManuscriptEmpiricalApplyApprovalPacket'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.kind === 'ManuscriptEmpiricalApplyApprovalPacket'
  )),
  empiricalManuscriptApplyApprovalReady: count((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.status === 'manuscript_empirical_apply_approval_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.status === 'manuscript_empirical_apply_approval_ready'
  )),
  empiricalManuscriptApplyPlans: count((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyPlan?.kind === 'ManuscriptEmpiricalApplyPlan'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyPlan?.kind === 'ManuscriptEmpiricalApplyPlan'
  )),
  empiricalManuscriptApplyPlanReady: count((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyPlan?.status === 'manuscript_empirical_apply_plan_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyPlan?.status === 'manuscript_empirical_apply_plan_ready'
  )),
  empiricalManuscriptApplyReceipts: count((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.kind === 'ManuscriptEmpiricalApplyReceipt'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.kind === 'ManuscriptEmpiricalApplyReceipt'
  )),
  empiricalManuscriptApplyApplied: count((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied'
  )),
  empiricalExternalActions: count((result) => (
    result.empiricalAnalysis?.safety?.externalActionPerformed === true
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.safety?.externalActionPerformed === true
  )),
  empiricalSourceMutations: count((result) => (
    result.empiricalAnalysis?.safety?.sourceMutation === true
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.safety?.sourceMutation === true
  )),
  localHeuristicVerdicts: reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.freshRefereeVerdictCount || 0)
  ), 0),
  localDiagnosticPasses: reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.diagnosticPassCount || 0)
  ), 0),
  localDiagnosticRevisions: reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.freshRefereeReviseCount || 0)
  ), 0),
  refereeOpenIssues: reduce((count, result) => (
    count + Number(result.refereeRevision?.openIssueCount || 0)
  ), 0),
  refereeReviewReports: count((result) => (
    result.refereeReview?.reviewReport?.kind === 'AgentRefereeReviewReport'
  )),
  refereeReviewReady: count((result) => (
    result.refereeReview?.reviewReport?.status === 'agent_referee_review_ready'
  )),
  refereeReviewBlocked: count((result) => (
    result.refereeReview?.reviewReport?.status === 'agent_referee_review_blocked'
    || result.refereeReview?.intake?.status === 'referee_review_intake_blocked'
  )),
  refereeReviewFindings: reduce((count, result) => (
    count + Number(result.refereeReview?.findingCount || 0)
  ), 0),
  refereeIssueQueueMaterializations: count((result) => (
    result.refereeReview?.materialization?.kind === 'RefereeIssueQueueMaterialization'
  )),
  refereeIssueQueueMaterializationPlanned: count((result) => (
    result.refereeReview?.materialization?.status === 'referee_issue_queue_materialization_planned'
  )),
  refereeIssueQueueMaterialized: count((result) => (
    result.refereeReview?.materialization?.status === 'referee_issue_queue_materialized'
  )),
  refereeIssueQueueMaterializationBlocked: count((result) => (
    result.refereeReview?.materialization?.status === 'referee_issue_queue_materialization_blocked'
  )),
  refereeReviewIssueRowsInserted: reduce((count, result) => (
    count + Number(result.refereeReview?.materializedIssueCount || 0)
  ), 0),
  refereeReviewIssueRowsAlreadyPresent: reduce((count, result) => (
    count + Number(result.refereeReview?.existingIssueCount || 0)
  ), 0),
  refereePreflightReady: count((result) => (
    result.refereeRevision?.patchExecutionPreflight?.status === 'dry_run_patch_execution_preflight_ready'
  )),
  refereeRollbackLedgerDrafts: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.rollbackLedgerDraft?.status === 'rollback_ledger_draft_ready'
  )),
  refereePreimageSnapshotLedgers: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.preimageSnapshotLedger?.kind === 'RefereeRevisionPreimageSnapshotLedger'
  )),
  refereePreimageSnapshotReady: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.preimageSnapshotLedger?.status === 'preimage_snapshot_ready'
  )),
  refereeExecutePlansReady: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executePlan?.status === 'execute_plan_ready_requires_explicit_apply_mode'
  )),
  refereeApplyModeContracts: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyModeContract?.kind === 'RefereeRevisionApplyModeContract'
  )),
  refereeExecuteDesignPackets: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executeDesignPacket?.kind === 'RefereeRevisionExecuteDesignPacket'
  )),
  refereeExecuteDesignReadyApplyBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executeDesignPacket?.status === 'referee_execute_design_ready_apply_blocked'
  )),
  refereeExecuteDesignReadyForApplyExecution: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executeDesignPacket?.status === 'referee_execute_design_ready_for_apply_execution'
  )),
  refereeApplyApprovalPackets: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.kind === 'RefereeApplyApprovalPacket'
  )),
  refereeApplyApprovalBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.status === 'referee_apply_approval_blocked'
  )),
  refereeApplyApprovalReady: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.status === 'referee_apply_approval_ready_for_patch_execution'
  )),
  refereeApplyAgentApproved: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.approvalActor === 'agent'
    && result.refereeRevision?.applyApprovalPacket?.approved === true
  )),
  refereePatchApplyExecutions: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyExecution?.kind === 'RefereePatchApplyExecution'
  )),
  refereePatchApplyExecutionBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyExecution?.status === 'referee_patch_apply_execution_blocked'
  )),
  refereePatchApplyExecutionReady: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyExecution?.status === 'referee_patch_apply_ready_for_separate_executor'
  )),
  refereePatchApplyApprovalGateBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.patchApplyExecution?.blockers || []).includes('referee_apply_approval_not_ready')
  )),
  refereePatchApplyInvocations: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.kind === 'RefereePatchApplyInvocation'
  )),
  refereePatchApplyInvocationBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.status === 'referee_patch_apply_invocation_blocked'
  )),
  refereePatchApplyInvocationRequired: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.patchApplyInvocation?.blockers || []).includes('explicit_referee_patch_apply_execute_invocation_required')
  )),
  refereePatchApplyValidationBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && Number(result.refereeRevision?.patchApplyInvocation?.validationRecordCount || 0) > 0
    && (result.refereeRevision?.patchApplyInvocation?.blockers || []).some((blocker) => (
      blocker.includes('patch_file')
      || blocker.includes('patch_hash')
      || blocker.includes('patch_path')
      || blocker.includes('patch_target')
      || blocker.includes('preimage_')
      || blocker.includes('combined_patch')
      || blocker.includes('git_apply')
    ))
  )),
  refereePatchApplyInvocationApplied: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.status === 'referee_patch_apply_invocation_applied'
  )),
  refereeAgentRepairPatchBundles: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.kind === 'RefereeAgentRepairPatchBundle'
  )),
  refereeAgentRepairPatchBundleReady: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.status === 'agent_repair_patch_bundle_ready'
  )),
  refereeAgentRepairPatchBundleAlreadyPresent: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.status === 'agent_repair_patch_already_present'
  )),
  refereeAgentRepairPatchBundleBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.status === 'agent_repair_patch_bundle_blocked'
  )),
  refereeSourceMutations: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.safety?.sourceMutation === true
  )),
  refereeAppliedPatchReceipts: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.appliedPatchReceipt?.kind === 'RefereeAppliedPatchReceipt'
  )),
  refereeAppliedPatchReceiptBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.appliedPatchReceipt?.status === 'applied_patch_receipt_blocked'
  )),
  refereeAppliedPatchReceiptRecorded: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.appliedPatchReceipt?.status === 'applied_patch_receipt_recorded'
  )),
  refereeAppliedPatchExecutionGateBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.appliedPatchReceipt?.blockers || []).includes('referee_patch_apply_execution_not_ready')
  )),
  refereeAppliedPatchInvocationGateBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.appliedPatchReceipt?.blockers || []).includes('referee_patch_apply_invocation_not_applied')
  )),
  refereePostRepairBuildPackages: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairBuildPackage?.kind === 'PostRepairBuildPackage'
  )),
  refereePostRepairBuildPackageBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairBuildPackage?.status === 'post_repair_build_package_blocked'
  )),
  refereePostRepairBuildPackageReady: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairBuildPackage?.status === 'post_repair_build_package_ready'
  )),
  refereePostRepairBuildRecheckPassed: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairRechecks?.buildRecheck?.status === 'build_recheck_passed'
  )),
  refereePostRepairPackageRewriteReady: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairRechecks?.packageRecheck?.status === 'package_rewrite_ready'
  )),
  refereePostRepairResearchRecheckPassed: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairRechecks?.researchRecheck?.status === 'research_recheck_passed'
  )),
  refereePostRepairAppliedReceiptGateBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.postRepairBuildPackage?.blockers || []).includes('applied_patch_receipt_not_recorded')
  )),
  refereeIssueResolutionProofs: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.issueResolutionProof?.kind === 'RefereeIssueResolutionProof'
  )),
  refereeIssueResolutionProofBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.issueResolutionProof?.status === 'referee_issue_resolution_proof_blocked'
  )),
  refereeIssueResolutionProofReady: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.issueResolutionProof?.status === 'referee_issue_resolution_proof_ready'
  )),
  refereeIssueResolutionEvidenceItems: reduce((sum, result) => (
    sum + Number(result.refereeRevision?.issueResolutionProof?.resolutionEvidenceCount || 0)
  ), 0),
  refereeIssueResolutionPostRepairGateBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.issueResolutionProof?.blockers || []).includes('post_repair_build_package_not_ready')
  )),
  refereeRepairReconciliations: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.kind === 'RepairReconciliation'
  )),
  refereeRepairReconciliationBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.status === 'repair_reconciliation_blocked'
  )),
  refereeRepairReconciliationReady: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.status === 'repair_reconciliation_ready'
  )),
  refereeRepairReconciled: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.repairReconciled === true
  )),
  refereeRepairStateMutationReceipts: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.kind === 'RepairStateMutationReceipt'
  )),
  refereeRepairStateMutationRecorded: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.status === 'repair_state_mutation_recorded'
  )),
  refereeRepairStateMutationBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.status === 'repair_state_mutation_blocked'
  )),
  refereeRepairStateMutationIssueRowsUpdated: reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.issueRowsUpdated || 0)
  ), 0),
  refereeRepairStateMutationPatchRowsInserted: reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.patchRowsInserted || 0)
  ), 0),
  refereeRepairStateMutationPatchRowsUpdated: reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.patchRowsUpdated || 0)
  ), 0),
  refereeRepairStateMutationPatchRowsAlreadyPresent: reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.patchRowsAlreadyPresent || 0)
  ), 0),
  refereeReviewedSubmitReadinessReleased: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.reviewedSubmitReadinessReleased === true
  )),
  refereeIssueStateMutations: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.issueStateMutationPerformed === true
  )),
  refereeSqliteWrites: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.safety?.writesSqlite === true
  )),
  refereeRepairReconciliationProofGateBlocked: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.repairReconciliation?.blockers || []).includes('referee_issue_resolution_proof_not_ready')
  )),
  refereeApplyApprovalRequired: count((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (
      (result.refereeRevision?.applyModeContract?.blockers || []).includes('agent_referee_apply_approval_required')
      || (result.refereeRevision?.applyApprovalPacket?.blockers || []).includes('agent_referee_apply_approval_required')
    )
  )),
});

export function summarizeResults(inputResults) {
  const metricCollector = createResultMetricCollector(inputResults);
  const results = metricCollector.results;
  const campaignMetrics = summarizeCampaignResults(results);
  const batchMetrics = registerResultMetricTable(results, BATCH_METRICS);
  const workflowMetrics = summarizeWorkflowResults(results);
  return metricCollector.resolve({
    ...campaignMetrics,
    ...batchMetrics,
    researchAcademicEvidenceReady: batchMetrics.academicEvidenceVerified,
    ...workflowMetrics,
  });
}
