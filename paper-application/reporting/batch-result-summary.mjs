import { summarizeWorkflowResults } from './workflow-result-summary.mjs';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';

export function summarizeResults(results) {
  const proposalStaging = {
    staged: results.filter((result) => result.task?.registry?.inventorySource === 'proposal_staging').length,
    sourceSkeletons: results.filter((result) => (
      result.task?.registry?.inventorySource === 'proposal_staging'
      && normalizeText(result.task?.sourceWorkspace).includes('/runtime/proposals/')
    )).length,
  };
  const buildArtifactAcceptance = {
    accepted: results.filter((result) => (
      result.buildResult?.buildArtifactAcceptance?.status === 'compiled_pdf_accepted_for_local_package'
      || (result.packageResult?.artifactPackage?.artifacts || []).some((artifact) => artifact.role === 'build_artifact_acceptance')
    )).length,
    compiledPdfArtifacts: results.filter((result) => (
      (result.packageResult?.artifactPackage?.artifacts || []).some((artifact) => artifact.role === 'compiled_pdf')
    )).length,
  };
  const researchTypedContracts = results.reduce((count, result) => (
    count + (result.researchReport?.typedContracts ? 1 : 0)
  ), 0);
  const legacyCatalogReferenceReceipts = results.reduce((count, result) => (
    count + Number(result.researchReport?.legacyCatalogReferenceReceiptCount || 0)
  ), 0);
  const legacyCatalogReferenceCount = Math.max(0, ...results.map((result) => (
    Number(result.researchReport?.legacyCatalogReferenceCount || 0)
  )));
  const nativeResearchWorkerPlans = results.filter((result) => (
    result.researchReport?.nativeResearchWorkerExecution?.planHash
  )).length;
  const nativeResearchWorkersExecuted = results.reduce((count, result) => (
    count + Number(result.researchReport?.executedResearchWorkerCount || 0)
  ), 0);
  const academicEvidenceVerified = results.filter((result) => (
    result.researchReport?.academicEvidenceStatus === 'academic_evidence_verified'
    && result.researchReport?.academicEvidenceEligible === true
  )).length;
  const researchContractReady = results.filter((result) => (
    result.researchReport?.typedContracts?.claimScopeContract?.kind === 'ClaimScopeContract'
    && result.researchReport?.typedContracts?.evidenceMatrixContract?.kind === 'EvidenceMatrixContract'
  )).length;
  const researchEvidenceCandidatePresent = results.filter((result) => (
    Number(result.researchReport?.sourceEvidenceCount || 0) > 0
    || Number(result.researchReport?.logEvidenceCount || 0) > 0
  )).length;
  const researchNativeExecutionReady = results.filter((result) => (
    result.researchReport?.nativeResearchWorkerExecution?.status === 'native_research_workers_verified'
    && Number(result.researchReport?.verifiedNativeResearchWorkerCount || 0) > 0
  )).length;
  const journalManageReports = results.filter((result) => (
    result.journalManagement?.kind === 'JournalManageAdapterReport'
  )).length;
  const journalConferenceRegistries = results.filter((result) => (
    result.journalManagement?.registry?.kind === 'JournalConferenceRegistry'
    || result.localDiagnosticReviewLoop?.journalConferenceRegistry?.kind === 'JournalConferenceRegistry'
  )).length;
  const targetSelectionPolicies = results.filter((result) => (
    result.journalManagement?.targetSelectionPolicy?.kind === 'TargetSelectionPolicy'
    || result.localDiagnosticReviewLoop?.targetSelectionPolicy?.kind === 'TargetSelectionPolicy'
  )).length;
  const journalTargetProfiles = results.filter((result) => (
    result.journalManagement?.targetProfile?.kind === 'JournalTargetProfile'
    || result.localDiagnosticReviewLoop?.targetJournalProfile?.kind === 'JournalTargetProfile'
  )).length;
  const journalTargetProfileReady = results.filter((result) => (
    result.journalManagement?.targetProfile?.status === 'journal_target_profile_ready'
    || result.localDiagnosticReviewLoop?.targetJournalProfile?.status === 'journal_target_profile_ready'
  )).length;
  const journalRubricPackets = results.filter((result) => (
    result.journalManagement?.rubricPacket?.kind === 'JournalRubricPacket'
    || result.localDiagnosticReviewLoop?.finalJournalRubricPacket?.kind === 'JournalRubricPacket'
  )).length;
  const journalRubricReady = results.filter((result) => (
    result.journalManagement?.rubricPacket?.status === 'journal_rubric_packet_ready'
    || result.localDiagnosticReviewLoop?.finalJournalRubricPacket?.status === 'journal_rubric_packet_ready'
  )).length;
  const venueRubricManagers = results.filter((result) => (
    result.journalManagement?.venueRubricManager?.kind === 'VenueRubricManager'
    || result.localDiagnosticReviewLoop?.finalVenueRubricManager?.kind === 'VenueRubricManager'
  )).length;
  const freshRefereePools = results.filter((result) => (
    result.journalManagement?.freshRefereePool?.kind === 'FreshRefereePool'
    || result.localDiagnosticReviewLoop?.finalFreshRefereePool?.kind === 'FreshRefereePool'
  )).length;
  const venueEvidenceGates = results.filter((result) => (
    result.journalManagement?.evidenceGate?.kind === 'VenueEvidenceGate'
    || result.localDiagnosticReviewLoop?.finalVenueEvidenceGate?.kind === 'VenueEvidenceGate'
  )).length;
  const venueEvidenceGateReady = results.filter((result) => (
    result.journalManagement?.evidenceGate?.status === 'venue_evidence_gate_ready'
    || result.localDiagnosticReviewLoop?.finalVenueEvidenceGate?.status === 'venue_evidence_gate_ready'
  )).length;
  const venueLifecyclePolicies = results.filter((result) => (
    result.journalManagement?.lifecyclePolicy?.kind === 'VenueLifecyclePolicy'
    || result.localDiagnosticReviewLoop?.finalVenueLifecyclePolicy?.kind === 'VenueLifecyclePolicy'
  )).length;
  const journalConferenceSystemPackets = results.filter((result) => (
    result.journalManagement?.systemPacket?.kind === 'JournalConferenceSystemPacket'
    || result.localDiagnosticReviewLoop?.journalConferenceSystemPacket?.kind === 'JournalConferenceSystemPacket'
  )).length;
  const empiricalAnalysisReports = results.filter((result) => (
    result.empiricalAnalysis?.kind === 'EmpiricalAnalysisAdapterReport'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.kind === 'EmpiricalAnalysisAdapterReport'
  )).length;
  const empiricalAnalysisEvidenceReady = results.filter((result) => (
    result.empiricalAnalysis?.status === 'empirical_analysis_evidence_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.status === 'empirical_analysis_evidence_ready'
  )).length;
  const empiricalBenchmarkRegistries = results.filter((result) => (
    result.empiricalAnalysis?.empiricalBenchmarkRegistry?.kind === 'EmpiricalBenchmarkRegistry'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.empiricalBenchmarkRegistry?.kind === 'EmpiricalBenchmarkRegistry'
  )).length;
  const empiricalBenchmarkRegistriesReady = results.filter((result) => (
    result.empiricalAnalysis?.empiricalBenchmarkRegistry?.status === 'empirical_benchmark_registry_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.empiricalBenchmarkRegistry?.status === 'empirical_benchmark_registry_ready'
  )).length;
  const benchmarkSuiteSelectionPolicies = results.filter((result) => (
    result.empiricalAnalysis?.benchmarkSuiteSelectionPolicy?.kind === 'BenchmarkSuiteSelectionPolicy'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.benchmarkSuiteSelectionPolicy?.kind === 'BenchmarkSuiteSelectionPolicy'
  )).length;
  const benchmarkSuiteSelectionReady = results.filter((result) => (
    result.empiricalAnalysis?.benchmarkSuiteSelectionPolicy?.status === 'benchmark_suite_selection_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.benchmarkSuiteSelectionPolicy?.status === 'benchmark_suite_selection_ready'
  )).length;
  const empiricalLocalBenchmarkRegistries = results.filter((result) => (
    result.empiricalAnalysis?.localBenchmarkRegistry?.kind === 'LocalBenchmarkRegistry'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.localBenchmarkRegistry?.kind === 'LocalBenchmarkRegistry'
  )).length;
  const empiricalLocalBenchmarkRegistryReady = results.filter((result) => (
    result.empiricalAnalysis?.localBenchmarkRegistry?.status === 'local_benchmark_registry_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.localBenchmarkRegistry?.status === 'local_benchmark_registry_ready'
  )).length;
  const empiricalAuthorizedLocalDatasets = results.filter((result) => (
    result.empiricalAnalysis?.datasetAccessContract?.datasetMode === 'authorized_local_dataset'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.datasetAccessContract?.datasetMode === 'authorized_local_dataset'
  )).length;
  const datasetLicenseProvenanceGates = results.filter((result) => (
    result.empiricalAnalysis?.datasetLicenseProvenanceGate?.kind === 'DatasetLicenseProvenanceGate'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.datasetLicenseProvenanceGate?.kind === 'DatasetLicenseProvenanceGate'
  )).length;
  const datasetLicenseProvenanceGateReady = results.filter((result) => (
    result.empiricalAnalysis?.datasetLicenseProvenanceGate?.status === 'dataset_license_provenance_gate_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.datasetLicenseProvenanceGate?.status === 'dataset_license_provenance_gate_ready'
  )).length;
  const tableFigureSpecs = results.filter((result) => (
    result.empiricalAnalysis?.tableFigureSpec?.kind === 'TableFigureSpec'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.tableFigureSpec?.kind === 'TableFigureSpec'
  )).length;
  const tableFigureSpecReady = results.filter((result) => (
    result.empiricalAnalysis?.tableFigureSpec?.status === 'table_figure_spec_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.tableFigureSpec?.status === 'table_figure_spec_ready'
  )).length;
  const empiricalExperimentRunReceipts = results.filter((result) => (
    result.empiricalAnalysis?.experimentRunReceipt?.kind === 'ExperimentRunReceipt'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.experimentRunReceipt?.kind === 'ExperimentRunReceipt'
  )).length;
  const empiricalExperimentRunRecorded = results.filter((result) => (
    result.empiricalAnalysis?.experimentRunReceipt?.status === 'experiment_run_receipt_recorded'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.experimentRunReceipt?.status === 'experiment_run_receipt_recorded'
  )).length;
  const empiricalResultArtifactPackages = results.filter((result) => (
    result.empiricalAnalysis?.resultArtifactPackage?.kind === 'ResultArtifactPackage'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.resultArtifactPackage?.kind === 'ResultArtifactPackage'
  )).length;
  const empiricalEvidenceGates = results.filter((result) => (
    result.empiricalAnalysis?.empiricalEvidenceGate?.kind === 'EmpiricalEvidenceGate'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.empiricalEvidenceGate?.kind === 'EmpiricalEvidenceGate'
  )).length;
  const empiricalEvidenceGateReady = results.filter((result) => (
    result.empiricalAnalysis?.empiricalEvidenceGate?.status === 'empirical_evidence_gate_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.empiricalEvidenceGate?.status === 'empirical_evidence_gate_ready'
  )).length;
  const empiricalManuscriptPatches = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalPatch?.kind === 'ManuscriptEmpiricalPatch'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalPatch?.kind === 'ManuscriptEmpiricalPatch'
  )).length;
  const empiricalManuscriptPatchReady = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalPatch?.status === 'manuscript_empirical_patch_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalPatch?.status === 'manuscript_empirical_patch_ready'
  )).length;
  const empiricalManuscriptApplyApprovalPackets = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.kind === 'ManuscriptEmpiricalApplyApprovalPacket'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.kind === 'ManuscriptEmpiricalApplyApprovalPacket'
  )).length;
  const empiricalManuscriptApplyApprovalReady = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.status === 'manuscript_empirical_apply_approval_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyApprovalPacket?.status === 'manuscript_empirical_apply_approval_ready'
  )).length;
  const empiricalManuscriptApplyPlans = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyPlan?.kind === 'ManuscriptEmpiricalApplyPlan'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyPlan?.kind === 'ManuscriptEmpiricalApplyPlan'
  )).length;
  const empiricalManuscriptApplyPlanReady = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyPlan?.status === 'manuscript_empirical_apply_plan_ready'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyPlan?.status === 'manuscript_empirical_apply_plan_ready'
  )).length;
  const empiricalManuscriptApplyReceipts = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.kind === 'ManuscriptEmpiricalApplyReceipt'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.kind === 'ManuscriptEmpiricalApplyReceipt'
  )).length;
  const empiricalManuscriptApplyApplied = results.filter((result) => (
    result.empiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied'
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.manuscriptEmpiricalApplyReceipt?.status === 'manuscript_empirical_apply_applied'
  )).length;
  const empiricalExternalActions = results.filter((result) => (
    result.empiricalAnalysis?.safety?.externalActionPerformed === true
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.safety?.externalActionPerformed === true
  )).length;
  const empiricalSourceMutations = results.filter((result) => (
    result.empiricalAnalysis?.safety?.sourceMutation === true
    || result.localDiagnosticReviewLoop?.finalEmpiricalAnalysis?.safety?.sourceMutation === true
  )).length;
  const localHeuristicVerdicts = results.reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.freshRefereeVerdictCount || 0)
  ), 0);
  const localDiagnosticPasses = results.reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.diagnosticPassCount || 0)
  ), 0);
  const localDiagnosticRevisions = results.reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.freshRefereeReviseCount || 0)
  ), 0);
  const refereeOpenIssues = results.reduce((count, result) => (
    count + Number(result.refereeRevision?.openIssueCount || 0)
  ), 0);
  const refereeReviewReports = results.filter((result) => (
    result.refereeReview?.reviewReport?.kind === 'AgentRefereeReviewReport'
  )).length;
  const refereeReviewReady = results.filter((result) => (
    result.refereeReview?.reviewReport?.status === 'agent_referee_review_ready'
  )).length;
  const refereeReviewBlocked = results.filter((result) => (
    result.refereeReview?.reviewReport?.status === 'agent_referee_review_blocked'
    || result.refereeReview?.intake?.status === 'referee_review_intake_blocked'
  )).length;
  const refereeReviewFindings = results.reduce((count, result) => (
    count + Number(result.refereeReview?.findingCount || 0)
  ), 0);
  const refereeIssueQueueMaterializations = results.filter((result) => (
    result.refereeReview?.materialization?.kind === 'RefereeIssueQueueMaterialization'
  )).length;
  const refereeIssueQueueMaterializationPlanned = results.filter((result) => (
    result.refereeReview?.materialization?.status === 'referee_issue_queue_materialization_planned'
  )).length;
  const refereeIssueQueueMaterialized = results.filter((result) => (
    result.refereeReview?.materialization?.status === 'referee_issue_queue_materialized'
  )).length;
  const refereeIssueQueueMaterializationBlocked = results.filter((result) => (
    result.refereeReview?.materialization?.status === 'referee_issue_queue_materialization_blocked'
  )).length;
  const refereeReviewIssueRowsInserted = results.reduce((count, result) => (
    count + Number(result.refereeReview?.materializedIssueCount || 0)
  ), 0);
  const refereeReviewIssueRowsAlreadyPresent = results.reduce((count, result) => (
    count + Number(result.refereeReview?.existingIssueCount || 0)
  ), 0);
  const refereePreflightReady = results.filter((result) => (
    result.refereeRevision?.patchExecutionPreflight?.status === 'dry_run_patch_execution_preflight_ready'
  )).length;
  const refereeRollbackLedgerDrafts = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.rollbackLedgerDraft?.status === 'rollback_ledger_draft_ready'
  )).length;
  const refereePreimageSnapshotLedgers = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.preimageSnapshotLedger?.kind === 'RefereeRevisionPreimageSnapshotLedger'
  )).length;
  const refereePreimageSnapshotReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.preimageSnapshotLedger?.status === 'preimage_snapshot_ready'
  )).length;
  const refereeExecutePlansReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executePlan?.status === 'execute_plan_ready_requires_explicit_apply_mode'
  )).length;
  const refereeApplyModeContracts = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyModeContract?.kind === 'RefereeRevisionApplyModeContract'
  )).length;
  const refereeExecuteDesignPackets = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executeDesignPacket?.kind === 'RefereeRevisionExecuteDesignPacket'
  )).length;
  const refereeExecuteDesignReadyApplyBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executeDesignPacket?.status === 'referee_execute_design_ready_apply_blocked'
  )).length;
  const refereeExecuteDesignReadyForApplyExecution = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.executeDesignPacket?.status === 'referee_execute_design_ready_for_apply_execution'
  )).length;
  const refereeApplyApprovalPackets = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.kind === 'RefereeApplyApprovalPacket'
  )).length;
  const refereeApplyApprovalBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.status === 'referee_apply_approval_blocked'
  )).length;
  const refereeApplyApprovalReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.status === 'referee_apply_approval_ready_for_patch_execution'
  )).length;
  const refereeApplyAgentApproved = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.applyApprovalPacket?.approvalActor === 'agent'
    && result.refereeRevision?.applyApprovalPacket?.approved === true
  )).length;
  const refereePatchApplyExecutions = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyExecution?.kind === 'RefereePatchApplyExecution'
  )).length;
  const refereePatchApplyExecutionBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyExecution?.status === 'referee_patch_apply_execution_blocked'
  )).length;
  const refereePatchApplyExecutionReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyExecution?.status === 'referee_patch_apply_ready_for_separate_executor'
  )).length;
  const refereePatchApplyApprovalGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.patchApplyExecution?.blockers || []).includes('referee_apply_approval_not_ready')
  )).length;
  const refereePatchApplyInvocations = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.kind === 'RefereePatchApplyInvocation'
  )).length;
  const refereePatchApplyInvocationBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.status === 'referee_patch_apply_invocation_blocked'
  )).length;
  const refereePatchApplyInvocationRequired = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.patchApplyInvocation?.blockers || []).includes('explicit_referee_patch_apply_execute_invocation_required')
  )).length;
  const refereePatchApplyValidationBlocked = results.filter((result) => (
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
  )).length;
  const refereePatchApplyInvocationApplied = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.status === 'referee_patch_apply_invocation_applied'
  )).length;
  const refereeAgentRepairPatchBundles = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.kind === 'RefereeAgentRepairPatchBundle'
  )).length;
  const refereeAgentRepairPatchBundleReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.status === 'agent_repair_patch_bundle_ready'
  )).length;
  const refereeAgentRepairPatchBundleAlreadyPresent = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.status === 'agent_repair_patch_already_present'
  )).length;
  const refereeAgentRepairPatchBundleBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.agentRepairPatchBundle?.status === 'agent_repair_patch_bundle_blocked'
  )).length;
  const refereeSourceMutations = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.patchApplyInvocation?.safety?.sourceMutation === true
  )).length;
  const refereeAppliedPatchReceipts = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.appliedPatchReceipt?.kind === 'RefereeAppliedPatchReceipt'
  )).length;
  const refereeAppliedPatchReceiptBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.appliedPatchReceipt?.status === 'applied_patch_receipt_blocked'
  )).length;
  const refereeAppliedPatchReceiptRecorded = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.appliedPatchReceipt?.status === 'applied_patch_receipt_recorded'
  )).length;
  const refereeAppliedPatchExecutionGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.appliedPatchReceipt?.blockers || []).includes('referee_patch_apply_execution_not_ready')
  )).length;
  const refereeAppliedPatchInvocationGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.appliedPatchReceipt?.blockers || []).includes('referee_patch_apply_invocation_not_applied')
  )).length;
  const refereePostRepairBuildPackages = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairBuildPackage?.kind === 'PostRepairBuildPackage'
  )).length;
  const refereePostRepairBuildPackageBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairBuildPackage?.status === 'post_repair_build_package_blocked'
  )).length;
  const refereePostRepairBuildPackageReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairBuildPackage?.status === 'post_repair_build_package_ready'
  )).length;
  const refereePostRepairBuildRecheckPassed = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairRechecks?.buildRecheck?.status === 'build_recheck_passed'
  )).length;
  const refereePostRepairPackageRewriteReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairRechecks?.packageRecheck?.status === 'package_rewrite_ready'
  )).length;
  const refereePostRepairResearchRecheckPassed = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.postRepairRechecks?.researchRecheck?.status === 'research_recheck_passed'
  )).length;
  const refereePostRepairAppliedReceiptGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.postRepairBuildPackage?.blockers || []).includes('applied_patch_receipt_not_recorded')
  )).length;
  const refereeIssueResolutionProofs = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.issueResolutionProof?.kind === 'RefereeIssueResolutionProof'
  )).length;
  const refereeIssueResolutionProofBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.issueResolutionProof?.status === 'referee_issue_resolution_proof_blocked'
  )).length;
  const refereeIssueResolutionProofReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.issueResolutionProof?.status === 'referee_issue_resolution_proof_ready'
  )).length;
  const refereeIssueResolutionEvidenceItems = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.issueResolutionProof?.resolutionEvidenceCount || 0)
  ), 0);
  const refereeIssueResolutionPostRepairGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.issueResolutionProof?.blockers || []).includes('post_repair_build_package_not_ready')
  )).length;
  const refereeRepairReconciliations = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.kind === 'RepairReconciliation'
  )).length;
  const refereeRepairReconciliationBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.status === 'repair_reconciliation_blocked'
  )).length;
  const refereeRepairReconciliationReady = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.status === 'repair_reconciliation_ready'
  )).length;
  const refereeRepairReconciled = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.repairReconciled === true
  )).length;
  const refereeRepairStateMutationReceipts = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.kind === 'RepairStateMutationReceipt'
  )).length;
  const refereeRepairStateMutationRecorded = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.status === 'repair_state_mutation_recorded'
  )).length;
  const refereeRepairStateMutationBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.status === 'repair_state_mutation_blocked'
  )).length;
  const refereeRepairStateMutationIssueRowsUpdated = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.issueRowsUpdated || 0)
  ), 0);
  const refereeRepairStateMutationPatchRowsInserted = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.patchRowsInserted || 0)
  ), 0);
  const refereeRepairStateMutationPatchRowsUpdated = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.patchRowsUpdated || 0)
  ), 0);
  const refereeRepairStateMutationPatchRowsAlreadyPresent = results.reduce((sum, result) => (
    sum + Number(result.refereeRevision?.repairStateMutationReceipt?.patchRowsAlreadyPresent || 0)
  ), 0);
  const refereeReviewedSubmitReadinessReleased = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairStateMutationReceipt?.reviewedSubmitReadinessReleased === true
  )).length;
  const refereeIssueStateMutations = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.issueStateMutationPerformed === true
  )).length;
  const refereeSqliteWrites = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && result.refereeRevision?.repairReconciliation?.safety?.writesSqlite === true
  )).length;
  const refereeRepairReconciliationProofGateBlocked = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (result.refereeRevision?.repairReconciliation?.blockers || []).includes('referee_issue_resolution_proof_not_ready')
  )).length;
  const refereeApplyApprovalRequired = results.filter((result) => (
    Number(result.refereeRevision?.openIssueCount || 0) > 0
    && (
      (result.refereeRevision?.applyModeContract?.blockers || []).includes('agent_referee_apply_approval_required')
      || (result.refereeRevision?.applyApprovalPacket?.blockers || []).includes('agent_referee_apply_approval_required')
    )
  )).length;
  const {
    lifecycleReconciled,
    lifecycleOutboxItems,
    submissionPreflight,
    localDiagnosticReviewLoopRuns,
    localDiagnosticReviewLoopPassed,
    localDiagnosticReviewLoopBlocked,
    localDiagnosticReviewLoopRounds,
    localDiagnosticReviewLoopFinalOpenIssues,
    localDiagnosticReviewLoopSourceMutations,
    localDiagnosticReviewLoopSqliteWrites,
    localDiagnosticReviewLoopReceipts,
    localDiagnosticReviewLoopPassRecorded,
    localDiagnosticReviewLoopExternalActions,
    venueResolution,
    sourceAdaptation,
  } = summarizeWorkflowResults(results);
  return {
    proposalStaging,
    buildArtifactAcceptance,
    researchTypedContracts,
    legacyCatalogReferenceReceipts,
    legacyCatalogReferenceCount,
    researchContractReady,
    researchEvidenceCandidatePresent,
    researchNativeExecutionReady,
    researchAcademicEvidenceReady: academicEvidenceVerified,
    nativeResearchWorkerPlans,
    nativeResearchWorkersExecuted,
    academicEvidenceVerified,
    journalManageReports,
    journalConferenceRegistries,
    targetSelectionPolicies,
    journalTargetProfiles,
    journalTargetProfileReady,
    journalRubricPackets,
    journalRubricReady,
    venueRubricManagers,
    freshRefereePools,
    venueEvidenceGates,
    venueEvidenceGateReady,
    venueLifecyclePolicies,
    journalConferenceSystemPackets,
    empiricalAnalysisReports,
    empiricalAnalysisEvidenceReady,
    empiricalBenchmarkRegistries,
    empiricalBenchmarkRegistriesReady,
    benchmarkSuiteSelectionPolicies,
    benchmarkSuiteSelectionReady,
    empiricalLocalBenchmarkRegistries,
    empiricalLocalBenchmarkRegistryReady,
    empiricalAuthorizedLocalDatasets,
    datasetLicenseProvenanceGates,
    datasetLicenseProvenanceGateReady,
    tableFigureSpecs,
    tableFigureSpecReady,
    empiricalExperimentRunReceipts,
    empiricalExperimentRunRecorded,
    empiricalResultArtifactPackages,
    empiricalEvidenceGates,
    empiricalEvidenceGateReady,
    empiricalManuscriptPatches,
    empiricalManuscriptPatchReady,
    empiricalManuscriptApplyApprovalPackets,
    empiricalManuscriptApplyApprovalReady,
    empiricalManuscriptApplyPlans,
    empiricalManuscriptApplyPlanReady,
    empiricalManuscriptApplyReceipts,
    empiricalManuscriptApplyApplied,
    empiricalExternalActions,
    empiricalSourceMutations,
    localHeuristicVerdicts,
    localDiagnosticPasses,
    localDiagnosticRevisions,
    refereeReviewReports,
    refereeReviewReady,
    refereeReviewBlocked,
    refereeReviewFindings,
    refereeIssueQueueMaterializations,
    refereeIssueQueueMaterializationPlanned,
    refereeIssueQueueMaterialized,
    refereeIssueQueueMaterializationBlocked,
    refereeReviewIssueRowsInserted,
    refereeReviewIssueRowsAlreadyPresent,
    refereeOpenIssues,
    refereePreflightReady,
    refereeRollbackLedgerDrafts,
    refereePreimageSnapshotLedgers,
    refereePreimageSnapshotReady,
    refereeExecutePlansReady,
    refereeApplyModeContracts,
    refereeExecuteDesignPackets,
    refereeExecuteDesignReadyApplyBlocked,
    refereeExecuteDesignReadyForApplyExecution,
    refereeApplyApprovalPackets,
    refereeApplyApprovalBlocked,
    refereeApplyApprovalReady,
    refereeApplyAgentApproved,
    refereePatchApplyExecutions,
    refereePatchApplyExecutionBlocked,
    refereePatchApplyExecutionReady,
    refereePatchApplyApprovalGateBlocked,
    refereePatchApplyInvocations,
    refereePatchApplyInvocationBlocked,
    refereePatchApplyInvocationRequired,
    refereePatchApplyValidationBlocked,
    refereePatchApplyInvocationApplied,
    refereeAgentRepairPatchBundles,
    refereeAgentRepairPatchBundleReady,
    refereeAgentRepairPatchBundleAlreadyPresent,
    refereeAgentRepairPatchBundleBlocked,
    refereeSourceMutations,
    refereeAppliedPatchReceipts,
    refereeAppliedPatchReceiptBlocked,
    refereeAppliedPatchReceiptRecorded,
    refereeAppliedPatchExecutionGateBlocked,
    refereeAppliedPatchInvocationGateBlocked,
    refereePostRepairBuildPackages,
    refereePostRepairBuildPackageBlocked,
    refereePostRepairBuildPackageReady,
    refereePostRepairBuildRecheckPassed,
    refereePostRepairPackageRewriteReady,
    refereePostRepairResearchRecheckPassed,
    refereePostRepairAppliedReceiptGateBlocked,
    refereeIssueResolutionProofs,
    refereeIssueResolutionProofBlocked,
    refereeIssueResolutionProofReady,
    refereeIssueResolutionEvidenceItems,
    refereeIssueResolutionPostRepairGateBlocked,
    refereeRepairReconciliations,
    refereeRepairReconciliationBlocked,
    refereeRepairReconciliationReady,
    refereeRepairReconciled,
    refereeRepairStateMutationReceipts,
    refereeRepairStateMutationRecorded,
    refereeRepairStateMutationBlocked,
    refereeRepairStateMutationIssueRowsUpdated,
    refereeRepairStateMutationPatchRowsInserted,
    refereeRepairStateMutationPatchRowsUpdated,
    refereeRepairStateMutationPatchRowsAlreadyPresent,
    refereeReviewedSubmitReadinessReleased,
    refereeIssueStateMutations,
    refereeSqliteWrites,
    refereeRepairReconciliationProofGateBlocked,
    refereeApplyApprovalRequired,
    localDiagnosticReviewLoopRuns,
    localDiagnosticReviewLoopPassed,
    localDiagnosticReviewLoopBlocked,
    localDiagnosticReviewLoopRounds,
    localDiagnosticReviewLoopFinalOpenIssues,
    localDiagnosticReviewLoopSourceMutations,
    localDiagnosticReviewLoopSqliteWrites,
    localDiagnosticReviewLoopReceipts,
    localDiagnosticReviewLoopPassRecorded,
    localDiagnosticReviewLoopExternalActions,
    lifecycleOutboxItems,
    lifecycleReconciled,
    submissionPreflight,
    venueResolution,
    sourceAdaptation,
  };
}
