import {
  createPaperWorkflowState,
  autoLevelForState,
  inferPaperStage,
  nextActionForState,
} from '../../paper-domain/contracts/index.mjs';

export function projectWorkflowState(row, { buildResult, packageResult, researchReport, refereeRevision, lifecycle } = {}) {
  const artifactPackage = packageResult?.artifactPackage || null;
  const hasCompiledPdf = (artifactPackage?.artifacts || []).some((artifact) => artifact.role === 'compiled_pdf');
  const submissionIntent = row.submissionIntent || row.task.registry?.submissionIntent || { status: 'submission_candidate', disposition: 'active_submission', reason: 'default_submission_candidate' };
  const compileStatus = buildResult?.status === 'build_passed' ? 'build_passed' : hasCompiledPdf ? 'compiled_pdf_present' : row.state.compileStatus;
  const researchVerifyStatus = ['evidence_present', 'proposal_seed_present'].includes(researchReport?.status) ? researchReport.status : row.state.researchVerifyStatus;
  const packageStatus = artifactPackage?.packageStatus || row.state.packageStatus;
  const runnerStatus = lifecycle?.receipt?.status === 'dry_run_recorded' ? 'dry_run_receipt_recorded' : row.state.runnerStatus;
  const submissionStatus = lifecycle?.venueStateProof?.status === 'dry_run_state_proof' ? 'venue_state_proof_recorded' : row.state.submissionStatus;
  const rawBlockers = [
    ...(row.state.blockers || []), ...(buildResult?.blockers || []), ...(packageResult?.blockers || []),
    ...(researchReport?.blockers || []), ...(refereeRevision?.blockers || []), ...(lifecycle?.venuePlan?.blockers || []),
    ...(lifecycle?.reviewedSubmit ? (lifecycle?.approvalPacket?.blockers || []) : []), ...(lifecycle?.manifest?.blockers || []),
  ];
  let blockers = rawBlockers;
  let forcedNextAction = null;
  let forcedAutoLevel = null;
  let forcedReadinessStatus = null;
  if (submissionIntent.status === 'needs_venue_decision') {
    blockers = rawBlockers.filter((blocker) => !['venue_target_missing', 'venue_submission_plan_not_ready'].includes(blocker));
    forcedReadinessStatus = blockers.length || (artifactPackage && !artifactPackage.submitReady) ? 'needs_local_package_before_venue_decision' : 'needs_venue_decision';
    forcedNextAction = 'paper.venue.resolve';
    forcedAutoLevel = 'manual_venue_decision';
  } else if (submissionIntent.status === 'source_adapt_required') {
    blockers = [];
    forcedReadinessStatus = 'source_adapt_required';
    forcedNextAction = 'paper.source.adapt';
    forcedAutoLevel = 'manual_source_adapt';
  } else if (submissionIntent.status === 'non_submission_archive') {
    blockers = [];
    forcedReadinessStatus = 'non_submission_archive';
    forcedNextAction = 'paper.archive.non_submission';
    forcedAutoLevel = 'non_submission_archive';
  }
  const warnings = [...(row.state.warnings || []), ...(buildResult?.warnings || []), ...(packageResult?.warnings || []), ...(researchReport?.warnings || []), ...(refereeRevision?.warnings || []), ...(lifecycle?.venuePlan?.warnings || []), ...(lifecycle?.manifest?.warnings || [])];
  const readinessStatus = forcedReadinessStatus || (blockers.length ? 'blocked' : ['package_present', 'package_ready'].includes(packageStatus) ? 'ready_for_local_dry_run' : row.state.readinessStatus);
  let state = createPaperWorkflowState({
    paperTask: row.task, draftStatus: row.state.draftStatus, compileStatus, researchVerifyStatus, packageStatus,
    readinessStatus, runnerStatus, submissionStatus, blockers, warnings, submissionIntent,
    evidenceRefs: [...(row.state.evidenceRefs || []), ...(artifactPackage?.evidenceRefs || [])],
  });
  state = { ...state, nextAction: forcedNextAction || nextActionForState(state), autoLevel: forcedAutoLevel || autoLevelForState(state) };
  return { ...state, stage: inferPaperStage(state) };
}
