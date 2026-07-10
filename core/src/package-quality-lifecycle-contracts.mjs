import path from 'node:path';

export const PACKAGE_QUALITY_LIFECYCLE_VERSION = 1;

export const TEN_IMAGE_REPAIR_STOP_POLICY_ID = 'ten_image_fail_under_five_no_continuous_repair';

export const QUALITY_REVIEW_DECISIONS = Object.freeze({
  PASS: 'pass',
  REVIEW: 'review',
  FAIL: 'fail',
});

export const PACKAGE_QUALITY_LIFECYCLE_SAFETY = Object.freeze({
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
});

export function normalizeQualityDecision(value, fallback = QUALITY_REVIEW_DECISIONS.REVIEW) {
  const text = String(value || '').toLowerCase();
  if (['pass', 'passed', 'ok'].includes(text)) return QUALITY_REVIEW_DECISIONS.PASS;
  if (['fail', 'failed', 'block', 'blocked'].includes(text)) return QUALITY_REVIEW_DECISIONS.FAIL;
  if (['review', 'needs_review', 'manual_review', 'pending'].includes(text)) return QUALITY_REVIEW_DECISIONS.REVIEW;
  return fallback;
}

export function decisionFromQualityChecks(checks = []) {
  const rows = Array.isArray(checks) ? checks : [];
  if (rows.some((item) => item?.blocking !== false && normalizeQualityDecision(item?.status || item?.decision) === QUALITY_REVIEW_DECISIONS.FAIL)) {
    return QUALITY_REVIEW_DECISIONS.FAIL;
  }
  if (rows.some((item) => item?.blocking !== false && normalizeQualityDecision(item?.status || item?.decision) !== QUALITY_REVIEW_DECISIONS.PASS)) {
    return QUALITY_REVIEW_DECISIONS.REVIEW;
  }
  return QUALITY_REVIEW_DECISIONS.PASS;
}

export function isUnpassedQualityCheck(check) {
  return check?.blocking !== false
    && normalizeQualityDecision(check?.status || check?.decision) !== QUALITY_REVIEW_DECISIONS.PASS;
}

export function isSemanticGatePlaceholderCheck(check) {
  const id = String(check?.id || check?.label || '');
  return id === 'semantic_referee_prompt_review'
    || id === 'gate_route_diversity'
    || /semantic_referee_(?:requires_execute|prompt_review|provider_error|spend_guard|unknown_provider)/.test(id);
}

export function onlySemanticGatePlaceholderBlockers(packageReview) {
  const blockers = (packageReview?.checks || []).filter(isUnpassedQualityCheck);
  return blockers.length > 0 && blockers.every(isSemanticGatePlaceholderCheck);
}

export function finalReviewFeedbackLine(check) {
  return `${check?.id || check?.label || 'final_review_check'}: ${String(
    check?.notes || check?.label || normalizeQualityDecision(check?.status || check?.decision) || '',
  ).replace(/\s+/g, ' ').trim().slice(0, 520)}`;
}

export function artifactNameAliases(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  const base = path.basename(text);
  const parsed = path.parse(base);
  const withoutImportSuffix = parsed.name.replace(/__\d+$/i, '');
  return [...new Set([
    text,
    base,
    parsed.name,
    withoutImportSuffix,
    withoutImportSuffix + (parsed.ext || ''),
  ].filter(Boolean))];
}

export function matchFinalReviewCheckToRequest(manifest, check) {
  const haystack = [
    check?.id,
    check?.label,
    check?.notes,
    check?.evidence,
    check?.file,
    check?.filename,
  ].flatMap(artifactNameAliases).join('\n');
  for (const request of manifest?.requests || []) {
    const candidates = [
      request.filename,
      request.result?.path ? path.basename(String(request.result.path)) : null,
      request.result?.path,
    ].flatMap(artifactNameAliases);
    if (candidates.some((candidate) => haystack.includes(candidate))) return request;
  }
  return null;
}

export function buildFinalReviewBridgeContract({
  manifest,
  finalReview,
  finalReviewPath = null,
  loop = null,
  now = new Date().toISOString(),
  source = 'generation-repair-loop',
} = {}) {
  const finalDecision = normalizeQualityDecision(finalReview?.decision);
  if (!finalReview || finalDecision === QUALITY_REVIEW_DECISIONS.PASS) {
    return { skipped: true, reason: finalReview ? 'final_review_pass' : 'final_review_missing', finalReviewPath };
  }
  const badChecks = (finalReview.checks || []).filter(isUnpassedQualityCheck);
  if (!badChecks.length) {
    return { skipped: true, reason: 'final_review_has_no_blocking_feedback', finalReviewPath, finalDecision };
  }

  const feedbackByRequest = new Map();
  for (const check of badChecks) {
    const request = matchFinalReviewCheckToRequest(manifest, check);
    if (!request) continue;
    const lines = feedbackByRequest.get(request.id) || [];
    lines.push(finalReviewFeedbackLine(check));
    feedbackByRequest.set(request.id, lines);
  }

  const artifactResponses = [...feedbackByRequest.entries()].map(([requestId, lines]) => {
    const failed = lines.some((line) => /:fail:|status.?fail|decision.?fail|"fail"| fail/i.test(line));
    return {
      requestId,
      ok: true,
      decision: failed ? QUALITY_REVIEW_DECISIONS.FAIL : QUALITY_REVIEW_DECISIONS.REVIEW,
      checks: lines.map((line, idx) => ({
        id: `final_review_feedback_${idx + 1}`,
        status: failed ? QUALITY_REVIEW_DECISIONS.FAIL : QUALITY_REVIEW_DECISIONS.REVIEW,
        blocking: true,
        notes: line,
      })),
      source: 'final-package-review',
    };
  });
  const packageChecks = badChecks.map((check, idx) => ({
    id: `final_review_${String(check.id || idx + 1).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 90)}`,
    label: check.label || check.id || 'Final-review feedback must be repaired before package-ready.',
    status: normalizeQualityDecision(check.status || check.decision),
    notes: finalReviewFeedbackLine(check),
    blocking: check.blocking !== false,
    source: 'final-package-review-bridge',
    appliesTo: 'package',
  }));

  return {
    skipped: false,
    finalReviewPath,
    finalDecision,
    targetCount: artifactResponses.length,
    semanticReferee: {
      status: 'final_review_feedback',
      decision: finalDecision,
      provider: finalReview.semanticReviewer?.provider || finalReview.semanticReviewer?.model || null,
      source: 'final-package-review',
      finalReviewPath,
      artifactResponses,
      checks: packageChecks,
      notes: finalReview.semanticReviewer?.notes || finalReview.semanticReviewer?.error || null,
    },
    packageReview: {
      version: 1,
      decision: finalDecision,
      reviewer: 'final-review-bridge',
      externalCalls: false,
      importReadyFiles: manifest?.importReadyFiles || [],
      checks: packageChecks,
      finalReviewBridge: true,
      finalReviewPath,
      reviewedAt: now,
      notes: 'final-review did not pass; bridged final feedback back into generation repair-loop',
    },
    finalReviewBridge: {
      source,
      loop,
      finalReviewPath,
      finalDecision,
      targetCount: artifactResponses.length,
      targetRequestIds: artifactResponses.map((item) => item.requestId),
      createdAt: now,
    },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function mergeFinalReviewBridgeManifest(options = {}) {
  const manifest = options.manifest && typeof options.manifest === 'object' ? cloneJson(options.manifest) : null;
  if (!manifest) return { skipped: true, reason: 'manifest_missing', finalReviewPath: options.finalReviewPath || null };
  const bridge = buildFinalReviewBridgeContract({ ...options, manifest });
  if (bridge.skipped) return bridge;
  manifest.semanticReferee = bridge.semanticReferee;
  manifest.packageReview = bridge.packageReview;
  manifest.finalReviewBridge = bridge.finalReviewBridge;
  manifest.reviewContextRefreshed = true;
  return { ...bridge, manifest };
}

export function evaluateTenImageRepairStopPolicy({
  enabled = true,
  plannedCount,
  attemptedCount,
  generatedCount,
  responseCount = 0,
  responseErrorCount = 0,
  failedCount,
  passingReadyCount,
} = {}) {
  const planned = Number(plannedCount || 0);
  if (!enabled) return { applies: false, reason: 'disabled_by_env' };
  if (planned !== 10) return { applies: false, reason: 'not_ten_image_package', plannedCount: planned };
  if (Number(attemptedCount || 0) !== planned) {
    return { applies: false, reason: 'ten_images_not_attempted', attemptedCount: Number(attemptedCount || 0), plannedCount: planned };
  }
  if (Number(generatedCount || 0) < 6) {
    return { applies: false, reason: 'ten_images_too_few_generated', generatedCount: Number(generatedCount || 0), plannedCount: planned };
  }
  if (Number(responseCount || 0) > 0 && Number(responseCount || 0) !== Number(generatedCount || 0)) {
    return { applies: false, reason: 'semantic_response_count_mismatch', semanticResponseCount: Number(responseCount || 0), generatedCount: Number(generatedCount || 0) };
  }
  if (Number(responseErrorCount || 0) > 0) return { applies: false, reason: 'semantic_referee_provider_error' };
  const failed = Number(failedCount || 0);
  const passingReady = Number(passingReadyCount || 0);
  const applies = failed > 0 && failed < 5 && passingReady >= 6;
  return {
    applies,
    policyId: TEN_IMAGE_REPAIR_STOP_POLICY_ID,
    plannedCount: planned,
    generatedCount: Number(generatedCount || 0),
    attemptedCount: Number(attemptedCount || 0),
    failedCount: failed,
    passingReadyCount: passingReady,
    acceptedFileCount: passingReady,
    threshold: 5,
    reason: applies ? 'user_policy_2026_05_27' : 'threshold_not_met',
    note: applies
      ? 'User policy: for 10-image packages, if fewer than 5 images fail, stop continuous repair and pass the package with the QA-passing subset.'
      : null,
  };
}

export function validateTenImageDirectPassPolicy(policy, files = []) {
  if (!policy?.applies || policy.policyId !== TEN_IMAGE_REPAIR_STOP_POLICY_ID) return null;
  if (Number(policy.plannedCount) !== 10) return null;
  if (Number(policy.failedCount) <= 0 || Number(policy.failedCount) >= 5) return null;
  if ((files || []).length !== Number(policy.acceptedFileCount || policy.passingReadyCount || 0)) return null;
  return policy;
}

export function packageQualityLifecycleSelftest() {
  const checks = [
    { id: 'a', status: 'pass', blocking: true },
    { id: 'b', status: 'review', blocking: true },
  ];
  const manifest = {
    importReadyFiles: ['/tmp/final-a.png'],
    requests: [
      { id: 'req-1', filename: 'final-a.png', result: { path: '/tmp/final-a.png' } },
      { id: 'req-2', filename: 'final-b.png', result: { path: '/tmp/final-b.png' } },
    ],
  };
  const bridge = mergeFinalReviewBridgeManifest({
    manifest,
    finalReview: {
      decision: 'fail',
      checks: [{ id: 'visual_subject', label: 'subject', status: 'fail', notes: 'final-a.png missing required subject' }],
      semanticReviewer: { provider: 'openclaw-image', notes: 'model fail' },
    },
    finalReviewPath: 'case/final-package-review-latest.json',
    loop: 1,
    now: '2026-06-21T00:00:00.000Z',
  });
  const policy = evaluateTenImageRepairStopPolicy({
    plannedCount: 10,
    attemptedCount: 10,
    generatedCount: 10,
    responseCount: 10,
    failedCount: 4,
    passingReadyCount: 6,
  });
  const placeholders = onlySemanticGatePlaceholderBlockers({
    checks: [{ id: 'semantic_referee_requires_execute', status: 'review', blocking: true }],
  });
  return {
    ok: decisionFromQualityChecks(checks) === QUALITY_REVIEW_DECISIONS.REVIEW
      && placeholders
      && bridge.skipped === false
      && bridge.targetCount === 1
      && bridge.manifest?.packageReview?.finalReviewBridge === true
      && policy.applies === true
      && validateTenImageDirectPassPolicy(policy, Array.from({ length: 6 }, (_, idx) => `${idx + 1}.png`)) === policy
      && PACKAGE_QUALITY_LIFECYCLE_SAFETY.grantsExecutionPermission === false,
    bridge,
    policy,
    safety: PACKAGE_QUALITY_LIFECYCLE_SAFETY,
  };
}
