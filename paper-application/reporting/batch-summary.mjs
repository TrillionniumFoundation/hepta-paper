import { PAPER_ACTIONS } from '../../paper-domain/contracts/index.mjs';

export { summarizeResults } from './batch-result-summary.mjs';
export { blockerFamilySummary, makeBlockerFamilyMarkdown } from './blocker-family-summary.mjs';

export function makeMarkdownTable(rows) {
  const headers = [
    'paper_id', 'venue', 'draft_status', 'compile_status', 'research_verify_status',
    'package_status', 'readiness_status', 'runner_status', 'submission_status',
    'next_action', 'auto_level', 'submission_intent', 'production_disposition',
  ];
  const escapeCell = (value) => String(value ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows) lines.push(`| ${headers.map((header) => escapeCell(row[header])).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

export function summarizeRows(rows, mode) {
  return {
    mode,
    total: rows.length,
    sourceReady: rows.filter((row) => row.draft_status === 'source_tex_present').length,
    buildReady: rows.filter((row) => ['compiled_pdf_present', 'build_ready', 'build_passed'].includes(row.compile_status)).length,
    researchContractStatusObserved: rows.filter((row) => ['verified', 'evidence_present', 'proposal_seed_present', 'manual_review_only'].includes(row.research_verify_status)).length,
    packageReady: rows.filter((row) => ['package_present', 'package_ready'].includes(row.package_status)).length,
    localDryRunReady: rows.filter((row) => row.readiness_status === 'ready_for_local_dry_run').length,
    dryRunReceipts: rows.filter((row) => row.runner_status === 'dry_run_receipt_recorded').length,
    reviewedSubmitBlocked: rows.filter((row) => row.next_action === PAPER_ACTIONS.REVIEWED_SUBMIT).length,
    blocked: rows.filter((row) => row.readiness_status === 'blocked').length,
    activeSubmissionCandidates: rows.filter((row) => row.production_disposition === 'active_submission').length,
    needsVenueDecision: rows.filter((row) => row.submission_intent === 'needs_venue_decision').length,
    needsSourceAdapt: rows.filter((row) => row.submission_intent === 'source_adapt_required').length,
    nonSubmissionArchive: rows.filter((row) => row.submission_intent === 'non_submission_archive').length,
  };
}
