import assert from 'node:assert/strict';
import test from 'node:test';
import {
  makeMarkdownTable,
  summarizeResults,
  summarizeRows,
} from '../src/batch-summary.mjs';

test('batch summary handles an empty batch without manufacturing readiness', () => {
  const summary = summarizeResults([]);
  assert.equal(summary.academicEvidenceVerified, 0);
  assert.equal(summary.submissionPreflight.externalActionsPerformed, 0);
  assert.equal(summary.legacyCleanup, null);
});

test('batch summary counts a sparse production result defensively', () => {
  const summary = summarizeResults([{
    task: { registry: { inventorySource: 'proposal_staging' }, sourceWorkspace: '/runtime/proposals/paper' },
    buildResult: {},
    packageResult: { artifactPackage: { artifacts: [] } },
    researchReport: {},
    journalManagement: {},
    empiricalAnalysis: {},
    refereeReview: {},
    refereeRevision: {},
    lifecycle: { reviewedSubmit: true, approvalPacket: { blockers: [] }, safety: {} },
    localDiagnosticReviewLoop: {},
    venueResolution: {},
    sourceAdaptation: {},
  }], { summary: { status: 'retired' } });
  assert.equal(summary.proposalStaging.staged, 1);
  assert.equal(summary.submissionPreflight.reviewedSubmitItems, 1);
  assert.deepEqual(summary.legacyCleanup, { status: 'retired' });
});

test('row and markdown summaries preserve the canonical paper columns', () => {
  const row = {
    paper_id: 'paper-1',
    venue: 'JMLR',
    draft_status: 'source_tex_present',
    compile_status: 'build_passed',
    research_verify_status: 'verified',
    package_status: 'package_ready',
    readiness_status: 'ready_for_local_dry_run',
    runner_status: 'dry_run_receipt_recorded',
    submission_status: 'not_submitted',
    next_action: 'reviewed_submit',
    auto_level: 'bounded',
    submission_intent: 'needs_venue_decision',
    production_disposition: 'active_submission',
  };
  const summary = summarizeRows([row], 'inventory');
  assert.equal(summary.sourceReady, 1);
  assert.equal(summary.activeSubmissionCandidates, 1);
  const markdown = makeMarkdownTable([row]);
  assert.match(markdown, /\| paper_id \| venue \|/);
  assert.match(markdown, /\| paper-1 \| JMLR \|/);
});
