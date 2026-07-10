import path from 'node:path';
import { GENERATION_STATUS, QA_DECISION } from './generation-contracts.mjs';

export const GENERATION_REPAIR_ROUTE_CONTRACT_VERSION = 1;

export const GENERATION_REPAIR_ROUTES = Object.freeze({
  NONE: 'none',
  REQUEST_SCOPED_PACKAGE_CHECKS: 'request_scoped_package_checks',
  RERUN_OR_UNLOCK_SEMANTIC_REFEREE: 'rerun_or_unlock_semantic_referee',
  REFRESH_SEMANTIC_CONTRACT: 'refresh_semantic_contract',
  REPLAN_SUBMIT_SHAPE: 'replan_submit_shape',
  REGENERATE_INCOMPLETE_OR_UNSELECTED_REQUESTS: 'regenerate_incomplete_or_unselected_requests',
  PACKAGE_QUALITY_REVISE_ALL_GENERATED: 'package_quality_revise_all_generated',
  OPERATOR_REQUESTED_REVISE_ALL_GENERATED: 'operator_requested_revise_all_generated',
  UNCLASSIFIED_PACKAGE_FAILURE: 'unclassified_package_failure',
});

export const GENERATION_REPAIR_ROUTE_SAFETY = Object.freeze({
  localContractOnly: true,
  readsFiles: false,
  writesFiles: false,
  callsProviderOrModel: false,
  fetchesChannelState: false,
  mutatesChannelState: false,
  uploads: false,
  submits: false,
  sendsMessages: false,
  acceptsDelivery: false,
  pays: false,
  grantsExecutionPermission: false,
  providerExecutionRequiresSeparateApproval: true,
});

export function normalizeGenerationRepairDecision(value) {
  const text = String(value || '').toLowerCase();
  if (['pass', 'passed', 'ok'].includes(text)) return QA_DECISION.PASS;
  if (['fail', 'failed', 'block', 'blocked'].includes(text)) return QA_DECISION.FAIL;
  if (['review', 'needs_review', 'manual_review', 'pending'].includes(text)) return QA_DECISION.REVIEW;
  return QA_DECISION.REVIEW;
}

export function isUnpassedGenerationRepairCheck(check) {
  return check?.blocking !== false && normalizeGenerationRepairDecision(check?.status || check?.decision) !== QA_DECISION.PASS;
}

export function compactGenerationRepairText(value, limit = 360) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export function generationFeedbackLinesFromResponse(response) {
  const lines = [];
  if (!response) return lines;
  const decision = normalizeGenerationRepairDecision(response.decision);
  if (decision !== QA_DECISION.PASS) lines.push(`referee decision: ${decision}`);
  for (const check of response.checks || []) {
    if (!isUnpassedGenerationRepairCheck(check)) continue;
    const id = check.id || check.label || 'referee_check';
    const notes = compactGenerationRepairText(check.notes || check.evidence || check.label || '');
    lines.push(`${id}: ${notes || normalizeGenerationRepairDecision(check.status || check.decision)}`);
  }
  for (const flag of response.riskFlags || []) lines.push(`risk: ${compactGenerationRepairText(flag)}`);
  for (const evidence of response.evidence || []) {
    if (typeof evidence === 'string') lines.push(`evidence: ${compactGenerationRepairText(evidence)}`);
    else if (evidence?.quote || evidence?.notes) lines.push(`evidence: ${compactGenerationRepairText(evidence.quote || evidence.notes)}`);
  }
  return [...new Set(lines.filter(Boolean))].slice(0, 10);
}

export function generationPackageFeedbackLines(manifest) {
  const checks = manifest?.packageReview?.checks || [];
  return checks
    .filter(isUnpassedGenerationRepairCheck)
    .map((check) => `${check.id || check.label}: ${compactGenerationRepairText(check.notes || check.label || '')}`)
    .filter(Boolean)
    .slice(0, 8);
}

export function generationFinalReviewFeedbackLines(finalReview) {
  if (!finalReview || normalizeGenerationRepairDecision(finalReview.decision) === QA_DECISION.PASS) return [];
  const lines = [];
  for (const check of finalReview.checks || []) {
    if (!isUnpassedGenerationRepairCheck(check)) continue;
    lines.push(`${check.id || check.label || 'final_review_check'}: ${compactGenerationRepairText(check.notes || check.label || '')}`);
  }
  for (const check of finalReview.semanticReviewer?.checks || []) {
    if (!isUnpassedGenerationRepairCheck(check)) continue;
    lines.push(`semantic_${check.id || check.label || 'final_review_check'}: ${compactGenerationRepairText(check.notes || check.label || '')}`);
  }
  if (!lines.length && finalReview.semanticReviewer?.notes) {
    lines.push(`final_package_semantic_review: ${compactGenerationRepairText(finalReview.semanticReviewer.notes)}`);
  }
  if (!lines.length && finalReview.decision) {
    lines.push(`final_package_review: final review decision ${normalizeGenerationRepairDecision(finalReview.decision)}`);
  }
  return [...new Set(lines.filter(Boolean))].slice(0, 12);
}

export function failedGenerationPackageChecks(manifest) {
  return (manifest?.packageReview?.checks || []).filter(isUnpassedGenerationRepairCheck);
}

export function generatedRealRequests(manifest) {
  return (manifest?.requests || []).filter((request) => request.result?.ok && !request.result?.dryRun);
}

export function classifyGenerationPackageFailureRoute(manifest, args = {}) {
  const checks = failedGenerationPackageChecks(manifest);
  const decision = normalizeGenerationRepairDecision(manifest?.packageReview?.decision);
  if (decision === QA_DECISION.PASS || !checks.length) {
    return {
      version: GENERATION_REPAIR_ROUTE_CONTRACT_VERSION,
      route: GENERATION_REPAIR_ROUTES.NONE,
      canRevise: false,
      targetRequestIds: [],
      feedback: [],
      safety: GENERATION_REPAIR_ROUTE_SAFETY,
      next: 'package review is pass or has no blocking package checks',
    };
  }
  const feedback = generationPackageFeedbackLines(manifest);
  const byId = checks.map((check) => String(check.id || check.label || ''));
  const requestIds = [];
  for (const id of byId) {
    const match = id.match(/^package_artifact_review_(.+)$/)
      || id.match(/^package_qa_pass_(.+)$/)
      || id.match(/^package_blocking_checks_pass_(.+)$/);
    if (match) requestIds.push(match[1]);
  }
  if (requestIds.length) {
    return {
      version: GENERATION_REPAIR_ROUTE_CONTRACT_VERSION,
      route: GENERATION_REPAIR_ROUTES.REQUEST_SCOPED_PACKAGE_CHECKS,
      canRevise: true,
      targetRequestIds: [...new Set(requestIds)],
      feedback: ['package repair route: request_scoped_package_checks', ...feedback],
      safety: GENERATION_REPAIR_ROUTE_SAFETY,
      next: 'revise the requests named by package QA checks',
    };
  }
  if (byId.some((id) => /semantic_referee_(?:requires_execute|prompt_review|provider_error|spend_guard|unknown_provider)/.test(id))) {
    return {
      version: GENERATION_REPAIR_ROUTE_CONTRACT_VERSION,
      route: GENERATION_REPAIR_ROUTES.RERUN_OR_UNLOCK_SEMANTIC_REFEREE,
      canRevise: false,
      targetRequestIds: [],
      feedback,
      safety: GENERATION_REPAIR_ROUTE_SAFETY,
      next: 'rerun package-review with an approved executable semantic referee, or fix provider/auth before generation repair',
    };
  }
  if (byId.some((id) => /semantic_contract|source_hash|contract/i.test(id))) {
    return {
      version: GENERATION_REPAIR_ROUTE_CONTRACT_VERSION,
      route: GENERATION_REPAIR_ROUTES.REFRESH_SEMANTIC_CONTRACT,
      canRevise: false,
      targetRequestIds: [],
      feedback,
      safety: GENERATION_REPAIR_ROUTE_SAFETY,
      next: 'refresh model semantic intake / production plan before changing generated artifacts',
    };
  }
  if (byId.some((id) => /package_file_count_within_live_limit|drift_submit_mode_guard|text_form/i.test(id))) {
    return {
      version: GENERATION_REPAIR_ROUTE_CONTRACT_VERSION,
      route: GENERATION_REPAIR_ROUTES.REPLAN_SUBMIT_SHAPE,
      canRevise: false,
      targetRequestIds: [],
      feedback,
      safety: GENERATION_REPAIR_ROUTE_SAFETY,
      next: 'replan package shape, split, or submit mode; prompt revision alone cannot fix this package-level gate',
    };
  }
  if (byId.some((id) => /package_expected_count|package_has_import_ready_files/.test(id))) {
    const importReady = new Set((manifest.importReadyFiles || []).map((file) => path.resolve(String(file))));
    const targets = (manifest.requests || [])
      .filter((request) => !request.result?.ok || (request.result?.path && !importReady.has(path.resolve(String(request.result.path)))))
      .map((request) => request.id);
    return {
      version: GENERATION_REPAIR_ROUTE_CONTRACT_VERSION,
      route: GENERATION_REPAIR_ROUTES.REGENERATE_INCOMPLETE_OR_UNSELECTED_REQUESTS,
      canRevise: targets.length > 0,
      targetRequestIds: targets,
      feedback: ['package repair route: regenerate_incomplete_or_unselected_requests', ...feedback],
      safety: GENERATION_REPAIR_ROUTE_SAFETY,
      next: targets.length ? 'revise incomplete or non-import-ready requests' : 'run worker/QA/import-ready to complete the planned package',
    };
  }
  const text = checks.map((check) => `${check.id || ''} ${check.label || ''} ${check.notes || ''}`).join(' ').toLowerCase();
  if (/template|filler|professional|finish|generic|divers|cohesion|style|route|similar|weak|clipart|placeholder/.test(text)) {
    const targets = generatedRealRequests(manifest).map((request) => request.id);
    return {
      version: GENERATION_REPAIR_ROUTE_CONTRACT_VERSION,
      route: GENERATION_REPAIR_ROUTES.PACKAGE_QUALITY_REVISE_ALL_GENERATED,
      canRevise: targets.length > 0,
      targetRequestIds: targets,
      feedback: ['package repair route: package_quality_revise_all_generated', ...feedback],
      safety: GENERATION_REPAIR_ROUTE_SAFETY,
      next: targets.length ? 'revise all generated artifacts because package-level quality/style failed without request-scoped feedback' : 'regenerate package from the production plan',
    };
  }
  if (args['all-on-package-review'] || args['package-route'] === 'all') {
    const targets = generatedRealRequests(manifest).map((request) => request.id);
    return {
      version: GENERATION_REPAIR_ROUTE_CONTRACT_VERSION,
      route: GENERATION_REPAIR_ROUTES.OPERATOR_REQUESTED_REVISE_ALL_GENERATED,
      canRevise: targets.length > 0,
      targetRequestIds: targets,
      feedback: ['package repair route: operator_requested_revise_all_generated', ...feedback],
      safety: GENERATION_REPAIR_ROUTE_SAFETY,
      next: targets.length ? 'revise all generated artifacts by operator request' : 'no generated artifacts are available for revision',
    };
  }
  return {
    version: GENERATION_REPAIR_ROUTE_CONTRACT_VERSION,
    route: GENERATION_REPAIR_ROUTES.UNCLASSIFIED_PACKAGE_FAILURE,
    canRevise: false,
    targetRequestIds: [],
    feedback,
    safety: GENERATION_REPAIR_ROUTE_SAFETY,
    next: 'package failure is not safely mappable to generation; inspect report or pass --package-route all after review',
  };
}

export function generationRevisionFilename(filename, revisionNumber) {
  const parsed = path.parse(String(filename || 'artifact.png'));
  const cleaned = parsed.name.replace(/-rev\d+$/i, '');
  return `${cleaned}-rev${revisionNumber}${parsed.ext || '.png'}`;
}

export function nextGenerationRevisionNumber(request) {
  const history = Array.isArray(request?.revisionHistory) ? request.revisionHistory : [];
  const fromHistory = history.map((item) => Number(item.revisionNumber || 0)).filter(Number.isFinite);
  const current = Number(request?.revisionNumber || 0);
  return Math.max(current, ...fromHistory, 0) + 1;
}

export function buildGenerationRevisionPrompt({ request = {}, feedback = [], packageFeedback = [], revisionNumber = 1 } = {}) {
  const basePrompt = request.basePrompt || request.originalPrompt || request.prompt || '';
  const lines = [...new Set([...(feedback || []), ...(packageFeedback || [])].filter(Boolean))].slice(0, 16);
  return [
    String(basePrompt).trim(),
    '',
    `REFEREE REVISION INSTRUCTIONS rev${revisionNumber}:`,
    'Regenerate this artifact from scratch. Do not patch the old image with title bars, chips, masks, pasted text, or cover-up overlays.',
    'Fix every blocking referee issue below while preserving the buyer subject, required brand/product text, workflow intent, and file role.',
    ...lines.map((line, idx) => `${idx + 1}. ${line}`),
    '',
    'Quality bar: client-facing finished design. Color palettes, typography/font-weight samples, construction grids, and application mockups are acceptable VI proof when meaningful. Avoid weak clipart, empty placeholders, unrelated fake spec chips, raw process labels, and stock filler that replaces client-specific logo proof.',
  ].filter(Boolean).join('\n');
}

export function generationRepairRouteContractsSelftest() {
  const manifest = {
    taskId: 999131,
    workflowId: 'logo_brand',
    requests: [
      { id: 'req-1', filename: 'good.png', status: GENERATION_STATUS.QA_PASS, result: { ok: true, path: '/tmp/good.png', dryRun: false } },
      { id: 'req-2', filename: 'bad.png', status: GENERATION_STATUS.QA_FAILED, result: { ok: true, path: '/tmp/bad.png', dryRun: false } },
    ],
    importReadyFiles: ['/tmp/good.png', '/tmp/bad.png'],
    packageReview: {
      decision: QA_DECISION.FAIL,
      checks: [{ id: 'package_template_filler_absence', status: QA_DECISION.FAIL, blocking: true, notes: 'package is generic template filler' }],
    },
  };
  const route = classifyGenerationPackageFailureRoute(manifest);
  const request = { filename: 'bad.png', prompt: 'make a weak board', revisionHistory: [{ revisionNumber: 1 }] };
  const next = nextGenerationRevisionNumber(request);
  const filename = generationRevisionFilename(request.filename, next);
  const prompt = buildGenerationRevisionPrompt({
    request,
    feedback: route.feedback,
    revisionNumber: next,
  });
  return {
    ok: route.route === GENERATION_REPAIR_ROUTES.PACKAGE_QUALITY_REVISE_ALL_GENERATED
      && route.canRevise
      && route.targetRequestIds.length === 2
      && next === 2
      && filename === 'bad-rev2.png'
      && /REFEREE REVISION INSTRUCTIONS rev2/.test(prompt)
      && /generic template filler/i.test(prompt),
    safety: GENERATION_REPAIR_ROUTE_SAFETY,
    route,
    filename,
    promptHasFeedback: /generic template filler/i.test(prompt),
  };
}
