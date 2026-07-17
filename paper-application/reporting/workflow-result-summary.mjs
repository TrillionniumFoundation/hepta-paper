import {
  createResultMetricCollector,
  isMetricResultView,
  registerResultMetricTable,
  resultMetric,
} from './metric-descriptor-collector.mjs';

const { count, sum } = resultMetric;

const WORKFLOW_METRICS = Object.freeze({
  lifecycleReconciled: count((result) => result.lifecycle?.reconciliation?.status === 'dry_run_reconciled'),
  lifecycleOutboxItems: count((result) => result.lifecycle?.outbox?.kind === 'ExternalExecutorHandoffOutbox'),
  submissionPreflight: Object.freeze({
    lifecycleItems: count((result) => Boolean(result.lifecycle)),
    reviewedSubmitItems: count((result) => result.lifecycle?.reviewedSubmit),
    approvalPackets: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.approvalPacket?.kind === 'SubmissionApprovalPacket'
    )),
    approvalBlocked: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.approvalPacket?.status === 'blocked_approval_packet'
    )),
    approvalRequired: count((result) => (
      result.lifecycle?.reviewedSubmit
      && (result.lifecycle?.approvalPacket?.blockers || []).includes('explicit_reviewed_submit_approval_required')
    )),
    academicEvidenceRequired: count((result) => (
      result.lifecycle?.reviewedSubmit
      && (result.lifecycle?.approvalPacket?.blockers || []).includes('attested_academic_evidence_required_for_reviewed_submit')
    )),
    independentRefereeAuthorityRequired: count((result) => (
      result.lifecycle?.reviewedSubmit
      && (result.lifecycle?.approvalPacket?.blockers || []).includes('independent_referee_acceptance_authority_required')
    )),
    independentRefereeAuthorityVerified: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.independentReviewAuthorityReceipt?.status === 'independent_referee_acceptance_verified'
    )),
    liveAuthorizationRequired: count((result) => (
      result.lifecycle?.reviewedSubmit
      && (result.lifecycle?.approvalPacket?.blockers || []).includes('live_submission_authorization_required')
    )),
    liveAuthorizationVerified: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.liveAuthorizationReceipt?.status === 'live_submission_authorization_verified'
    )),
    approvalAgentApproved: count((result) => (
      result.lifecycle?.reviewedSubmit && result.lifecycle?.approvalPacket?.agentApproved === true
    )),
    reviewedSubmitPreflightPackets: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.reviewedSubmitPreflightPacket?.kind === 'ReviewedSubmitPreflightPacket'
    )),
    reviewedSubmitPreflightBlocked: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.reviewedSubmitPreflightPacket?.status === 'reviewed_submit_preflight_blocked'
    )),
    reviewedSubmitPreflightReady: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.reviewedSubmitPreflightPacket?.status === 'reviewed_submit_preflight_ready_for_external_executor'
    )),
    freshVenueEvidenceReady: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.freshVenueEvidenceBundle?.status === 'fresh_venue_evidence_ready'
    )),
    executorOutboxItems: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.outbox?.kind === 'ExternalExecutorHandoffOutbox'
    )),
    executorOutboxBlocked: count((result) => (
      result.lifecycle?.reviewedSubmit && result.lifecycle?.outbox?.status === 'blocked_outbox_item'
    )),
    controlledExecutorReceipts: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.controlledExecutorReceipt?.kind === 'ControlledExternalExecutorReceipt'
    )),
    controlledExecutorReceiptRecorded: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.controlledExecutorReceipt?.status === 'controlled_external_executor_receipt_recorded'
    )),
    controlledExecutorReceiptBlocked: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.controlledExecutorReceipt?.status === 'controlled_external_executor_blocked'
    )),
    liveExecutorBoundaryBlocked: count((result) => (
      result.lifecycle?.reviewedSubmit
      && result.lifecycle?.reviewedSubmitPreflightPacket?.liveExecutorBoundaryBlocked === true
    )),
    externalExecutorImplementationPresent: count((result) => (
      result.lifecycle?.reviewedSubmit && result.lifecycle?.safety?.executorImplementationPresent === true
    )),
    externalActionsPerformed: count((result) => (
      result.lifecycle?.reviewedSubmit
      && (result.lifecycle?.receipt?.externalActionPerformed || result.lifecycle?.safety?.externalActionPerformed)
    )),
  }),
  localDiagnosticReviewLoopRuns: count((result) => (
    result.localDiagnosticReviewLoop?.kind === 'LocalDiagnosticReviewLoopReport'
  )),
  localDiagnosticReviewLoopPassed: count((result) => (
    result.localDiagnosticReviewLoop?.diagnosticClosureReached === true
  )),
  localDiagnosticReviewLoopBlocked: count((result) => (
    result.localDiagnosticReviewLoop?.status === 'local_diagnostic_review_blocked'
  )),
  localDiagnosticReviewLoopRounds: sum((result) => result.localDiagnosticReviewLoop?.roundsCompleted),
  localDiagnosticReviewLoopFinalOpenIssues: sum((result) => result.localDiagnosticReviewLoop?.finalOpenIssueCount),
  localDiagnosticReviewLoopSourceMutations: sum((result) => result.localDiagnosticReviewLoop?.sourceMutationCount),
  localDiagnosticReviewLoopSqliteWrites: sum((result) => result.localDiagnosticReviewLoop?.sqliteWriteCount),
  localDiagnosticReviewLoopReceipts: count((result) => (
    result.localDiagnosticReviewLoop?.diagnosticReceipt?.kind === 'LocalDiagnosticReviewLoopReceipt'
  )),
  localDiagnosticReviewLoopPassRecorded: count((result) => (
    result.localDiagnosticReviewLoop?.diagnosticReceipt?.status === 'local_diagnostic_review_pass_recorded'
  )),
  localDiagnosticReviewLoopExternalActions: count((result) => (
    result.localDiagnosticReviewLoop?.safety?.externalActionPerformed === true
  )),
  venueResolution: Object.freeze({
    required: count((result) => result.venueResolution?.venueResolutionRequired),
    packets: count((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.packet?.kind === 'VenueResolutionPacket'
    )),
    manualDecisionRequired: count((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.packet?.status === 'manual_venue_decision_required'
    )),
    waitingForLocalPackage: count((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.packet?.status === 'venue_resolution_waiting_for_local_package'
    )),
    withCandidateVenues: count((result) => (
      result.venueResolution?.venueResolutionRequired
      && Number(result.venueResolution?.candidateCount || 0) > 0
    )),
    submitReadyPackagePlansRequired: count((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.submitReadyPackagePlan?.status === 'submit_ready_package_plan_required'
    )),
    registryAddPlansReady: count((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.venueRegistryAddPlan?.status === 'registry_add_plan_requires_operator_target'
    )),
    operatorPacketsReady: count((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.venueResolutionOperatorPacket?.status === 'venue_operator_decision_ready'
    )),
    operatorPacketsBlocked: count((result) => (
      result.venueResolution?.venueResolutionRequired
      && result.venueResolution?.venueResolutionOperatorPacket?.status === 'venue_operator_packet_blocked'
    )),
  }),
  sourceAdaptation: Object.freeze({
    required: count((result) => result.sourceAdaptation?.sourceAdaptationRequired),
    packets: count((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.packet?.kind === 'SourceAdaptationPacket'
    )),
    manualSourceDecisionRequired: count((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.packet?.status === 'manual_source_decision_required'
    )),
    mainTexCandidateReviewRequired: count((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.packet?.status === 'main_tex_candidate_review_required'
    )),
    withTexCandidates: count((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && Number(result.sourceAdaptation?.packet?.texCandidateCount || 0) > 0
    )),
    pdfOnlyOrCodeProject: count((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && Number(result.sourceAdaptation?.packet?.pdfCandidateCount || 0) > 0
      && Number(result.sourceAdaptation?.packet?.texCandidateCount || 0) === 0
    )),
    operatorPacketsReady: count((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && ['main_tex_selection_ready', 'source_material_decision_ready'].includes(
        result.sourceAdaptation?.sourceAdaptationOperatorPacket?.status,
      )
    )),
    operatorPacketsBlocked: count((result) => (
      result.sourceAdaptation?.sourceAdaptationRequired
      && result.sourceAdaptation?.sourceAdaptationOperatorPacket?.status === 'source_operator_packet_blocked'
    )),
  }),
});

export function summarizeWorkflowResults(inputResults) {
  const ownsMetricCollector = !isMetricResultView(inputResults);
  const metricCollector = ownsMetricCollector
    ? createResultMetricCollector(inputResults)
    : inputResults.collector;
  const results = ownsMetricCollector ? metricCollector.results : inputResults;
  const summary = registerResultMetricTable(results, WORKFLOW_METRICS);
  return ownsMetricCollector ? metricCollector.resolve(summary) : summary;
}
