export function summarizeWorkflowResults(results) {
  const lifecycleReconciled = results.filter((result) => result.lifecycle?.reconciliation?.status === 'dry_run_reconciled').length;
  const lifecycleOutboxItems = results.filter((result) => result.lifecycle?.outbox?.kind === 'ExternalExecutorHandoffOutbox').length;
  const lifecycles = results.map((result) => result.lifecycle).filter(Boolean);
  const reviewedSubmitLifecycles = lifecycles.filter((lifecycle) => lifecycle.reviewedSubmit);
  const submissionPreflight = {
    lifecycleItems: lifecycles.length,
    reviewedSubmitItems: reviewedSubmitLifecycles.length,
    approvalPackets: reviewedSubmitLifecycles.filter((lifecycle) => lifecycle.approvalPacket?.kind === 'SubmissionApprovalPacket').length,
    approvalBlocked: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.approvalPacket?.status === 'blocked_approval_packet'
    )).length,
    approvalRequired: reviewedSubmitLifecycles.filter((lifecycle) => (
      (lifecycle.approvalPacket?.blockers || []).includes('explicit_reviewed_submit_approval_required')
    )).length,
    academicEvidenceRequired: reviewedSubmitLifecycles.filter((lifecycle) => (
      (lifecycle.approvalPacket?.blockers || []).includes('attested_academic_evidence_required_for_reviewed_submit')
    )).length,
    independentRefereeAuthorityRequired: reviewedSubmitLifecycles.filter((lifecycle) => (
      (lifecycle.approvalPacket?.blockers || []).includes('independent_referee_acceptance_authority_required')
    )).length,
    independentRefereeAuthorityVerified: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.independentReviewAuthorityReceipt?.status === 'independent_referee_acceptance_verified'
    )).length,
    liveAuthorizationRequired: reviewedSubmitLifecycles.filter((lifecycle) => (
      (lifecycle.approvalPacket?.blockers || []).includes('live_submission_authorization_required')
    )).length,
    liveAuthorizationVerified: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.liveAuthorizationReceipt?.status === 'live_submission_authorization_verified'
    )).length,
    approvalAgentApproved: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.approvalPacket?.agentApproved === true
    )).length,
    reviewedSubmitPreflightPackets: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.reviewedSubmitPreflightPacket?.kind === 'ReviewedSubmitPreflightPacket'
    )).length,
    reviewedSubmitPreflightBlocked: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.reviewedSubmitPreflightPacket?.status === 'reviewed_submit_preflight_blocked'
    )).length,
    reviewedSubmitPreflightReady: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.reviewedSubmitPreflightPacket?.status === 'reviewed_submit_preflight_ready_for_external_executor'
    )).length,
    freshVenueEvidenceReady: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.freshVenueEvidenceBundle?.status === 'fresh_venue_evidence_ready'
    )).length,
    executorOutboxItems: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.outbox?.kind === 'ExternalExecutorHandoffOutbox'
    )).length,
    executorOutboxBlocked: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.outbox?.status === 'blocked_outbox_item'
    )).length,
    controlledExecutorReceipts: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.controlledExecutorReceipt?.kind === 'ControlledExternalExecutorReceipt'
    )).length,
    controlledExecutorReceiptRecorded: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.controlledExecutorReceipt?.status === 'controlled_external_executor_receipt_recorded'
    )).length,
    controlledExecutorReceiptBlocked: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.controlledExecutorReceipt?.status === 'controlled_external_executor_blocked'
    )).length,
    liveExecutorBoundaryBlocked: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.reviewedSubmitPreflightPacket?.liveExecutorBoundaryBlocked === true
    )).length,
    externalExecutorImplementationPresent: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.safety?.executorImplementationPresent === true
    )).length,
    externalActionsPerformed: reviewedSubmitLifecycles.filter((lifecycle) => (
      lifecycle.receipt?.externalActionPerformed || lifecycle.safety?.externalActionPerformed
    )).length,
  };
  const localDiagnosticReviewLoopRuns = results.filter((result) => (
    result.localDiagnosticReviewLoop?.kind === 'LocalDiagnosticReviewLoopReport'
  )).length;
  const localDiagnosticReviewLoopPassed = results.filter((result) => (
    result.localDiagnosticReviewLoop?.diagnosticClosureReached === true
  )).length;
  const localDiagnosticReviewLoopBlocked = results.filter((result) => (
    result.localDiagnosticReviewLoop?.status === 'local_diagnostic_review_blocked'
  )).length;
  const localDiagnosticReviewLoopRounds = results.reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.roundsCompleted || 0)
  ), 0);
  const localDiagnosticReviewLoopFinalOpenIssues = results.reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.finalOpenIssueCount || 0)
  ), 0);
  const localDiagnosticReviewLoopSourceMutations = results.reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.sourceMutationCount || 0)
  ), 0);
  const localDiagnosticReviewLoopSqliteWrites = results.reduce((sum, result) => (
    sum + Number(result.localDiagnosticReviewLoop?.sqliteWriteCount || 0)
  ), 0);
  const localDiagnosticReviewLoopReceipts = results.filter((result) => (
    result.localDiagnosticReviewLoop?.diagnosticReceipt?.kind === 'LocalDiagnosticReviewLoopReceipt'
  )).length;
  const localDiagnosticReviewLoopPassRecorded = results.filter((result) => (
    result.localDiagnosticReviewLoop?.diagnosticReceipt?.status === 'local_diagnostic_review_pass_recorded'
  )).length;
  const localDiagnosticReviewLoopExternalActions = results.filter((result) => (
    result.localDiagnosticReviewLoop?.safety?.externalActionPerformed === true
  )).length;
  const venueResolution = {
    required: results.filter((result) => result.venueResolution?.venueResolutionRequired).length,
    packets: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.packet?.kind === 'VenueResolutionPacket'
    )).length,
    manualDecisionRequired: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.packet?.status === 'manual_venue_decision_required'
    )).length,
    waitingForLocalPackage: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.packet?.status === 'venue_resolution_waiting_for_local_package'
    )).length,
    withCandidateVenues: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && Number(result.venueResolution?.candidateCount || 0) > 0
    )).length,
    submitReadyPackagePlansRequired: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.submitReadyPackagePlan?.status === 'submit_ready_package_plan_required'
    )).length,
    registryAddPlansReady: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.venueRegistryAddPlan?.status === 'registry_add_plan_requires_operator_target'
    )).length,
    operatorPacketsReady: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.venueResolutionOperatorPacket?.status === 'venue_operator_decision_ready'
    )).length,
    operatorPacketsBlocked: results.filter((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.venueResolutionOperatorPacket?.status === 'venue_operator_packet_blocked'
    )).length,
  };
  const sourceAdaptation = {
    required: results.filter((result) => result.sourceAdaptation?.sourceAdaptationRequired).length,
    packets: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.packet?.kind === 'SourceAdaptationPacket'
    )).length,
    manualSourceDecisionRequired: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.packet?.status === 'manual_source_decision_required'
    )).length,
    mainTexCandidateReviewRequired: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.packet?.status === 'main_tex_candidate_review_required'
    )).length,
    withTexCandidates: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && Number(result.sourceAdaptation?.packet?.texCandidateCount || 0) > 0
    )).length,
    pdfOnlyOrCodeProject: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && Number(result.sourceAdaptation?.packet?.pdfCandidateCount || 0) > 0
      && Number(result.sourceAdaptation?.packet?.texCandidateCount || 0) === 0
    )).length,
    operatorPacketsReady: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && ['main_tex_selection_ready', 'source_material_decision_ready'].includes(
        result.sourceAdaptation?.sourceAdaptationOperatorPacket?.status,
      )
    )).length,
    operatorPacketsBlocked: results.filter((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.sourceAdaptationOperatorPacket?.status === 'source_operator_packet_blocked'
    )).length,
  };
  return { lifecycleReconciled, lifecycleOutboxItems, submissionPreflight, localDiagnosticReviewLoopRuns, localDiagnosticReviewLoopPassed, localDiagnosticReviewLoopBlocked, localDiagnosticReviewLoopRounds, localDiagnosticReviewLoopFinalOpenIssues, localDiagnosticReviewLoopSourceMutations, localDiagnosticReviewLoopSqliteWrites, localDiagnosticReviewLoopReceipts, localDiagnosticReviewLoopPassRecorded, localDiagnosticReviewLoopExternalActions, venueResolution, sourceAdaptation };
}
