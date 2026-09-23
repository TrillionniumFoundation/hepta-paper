const CORE_STAGE_METHODS = Object.freeze([
  'empiricalAnalysis',
  'journalManage',
  'latexBuild',
  'packageArtifacts',
  'refereeReview',
  'refereeRevise',
  'researchVerify',
  'sourceAdapt',
  'venueResolve',
]);

const SUBMISSION_STAGE_METHODS = Object.freeze([
  'buildSubmissionLifecycle',
  'prepareSubmissionAuthorities',
]);

export function assertPaperStageExecutionPort(port, { requireSubmission = false } = {}) {
  if (Number(port?.version || 0) < 1) throw new Error('PaperStageExecutionPort.version 1 is required');
  for (const method of CORE_STAGE_METHODS) {
    if (typeof port?.[method] !== 'function') throw new Error(`PaperStageExecutionPort.${method} is required`);
  }
  if (requireSubmission) {
    for (const method of SUBMISSION_STAGE_METHODS) {
      if (typeof port?.[method] !== 'function') throw new Error(`PaperStageExecutionPort.${method} is required`);
    }
  }
  return port;
}
