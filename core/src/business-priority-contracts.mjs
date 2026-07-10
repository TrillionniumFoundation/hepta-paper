import { normalizeText } from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const BUSINESS_PRIORITY_SCORE_VERSION = 1;

function text(value) {
  return normalizeText(value || '');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function parseMoneyAmount(value) {
  const raw = text(value).replace(/,/g, '');
  const numbers = raw.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
  return numbers.length ? Math.max(...numbers) : 0;
}

export function deadlineHoursFromJob(job = {}, now = Date.now()) {
  const raw = job.deadline || job.deadlineAt || job.endTime || job.endAt || job.expireAt || job.expireTime || null;
  const when = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(when)) return null;
  return (when - now) / 3600000;
}

function collectReviewChecks(finalReview = null) {
  const candidates = [
    finalReview?.checks,
    finalReview?.packageChecks,
    finalReview?.reviewChecks,
    finalReview?.semanticChecks,
    finalReview?.visualChecks,
  ];
  return candidates.flatMap((items) => (Array.isArray(items) ? items : []));
}

function scoreDeadline(hours) {
  if (hours === null) return { score: 6, label: 'unknown_deadline' };
  if (hours < 0) return { score: -60, label: 'expired_or_no_live_entry_risk' };
  if (hours <= 6) return { score: 30, label: 'same_day_urgent' };
  if (hours <= 24) return { score: 23, label: 'within_24h' };
  if (hours <= 72) return { score: 14, label: 'within_72h' };
  return { score: 5, label: 'not_urgent' };
}

function scoreGate(next = {}, { finalReviewCurrentOk = false } = {}) {
  const base = {
    submit_ready: 78,
    submit_evidence: 74,
    submit_approval: 72,
    prepare_only: 64,
    live_resolver: 52,
    expand_package: 50,
    final_review: 45,
    qa_package_review: 38,
    semantic_contract: 34,
    provider_probe: 27,
    plan: 16,
    human_feedback_approval: 76,
    human_feedback_evidence: 74,
    human_feedback_human_review: 68,
    human_feedback_plan_round: 62,
    human_feedback_local_qa: 58,
    human_feedback_revise: 54,
    human_feedback_observe: 50,
    human_feedback_wait_customer: 34,
    human_feedback_repair_loop_state: 18,
    human_feedback_blocked: -40,
    human_feedback_closed: 0,
    im_feedback_do_work: 70,
    im_feedback_proof_review: 68,
    im_feedback_send_confirmation: 66,
    im_feedback_send_preflight_repair: 62,
    im_feedback_prepare_delivery: 64,
    im_feedback_trust_followup: 48,
    im_feedback_evidence_blocked: 12,
    already_submitted: 0,
    entry_refund_gate: -80,
  }[next.gate] ?? 22;
  const readinessBonus = finalReviewCurrentOk ? 8 : 0;
  return { score: base + readinessBonus, base, readinessBonus };
}

function scoreCompetition(job = {}) {
  const count = Number(job.worksCount ?? job.workCount ?? job.bidCount ?? job.manuscriptCount ?? job.competitionCount ?? NaN);
  if (!Number.isFinite(count)) return { score: 0, count: null, label: 'unknown_competition' };
  if (count <= 0) return { score: 12, count, label: 'no_visible_competition' };
  if (count <= 3) return { score: 8, count, label: 'low_competition' };
  if (count <= 10) return { score: 2, count, label: 'normal_competition' };
  if (count <= 30) return { score: -8, count, label: 'crowded' };
  return { score: -16, count, label: 'very_crowded' };
}

function scoreCostRisk({ manifest = null, auditState = null } = {}) {
  const providerId = text(manifest?.provider?.providerId || '');
  const cost = Number(auditState?.actualEstimatedCostUsd ?? auditState?.estimatedCostUsd ?? auditState?.budgetExposureUsd ?? 0);
  const providerPenalty = providerId === 'manual' ? 28 : (providerId === 'dryrun' ? 5 : 0);
  const costPenalty = Number.isFinite(cost) ? clamp(cost * 18, 0, 25) : 0;
  const authOrLimitPenalty = /429|usage_limit|auth|invalidated|quota/i.test(text(manifest?.lastError || manifest?.provider?.lastError || '')) ? 18 : 0;
  return {
    penalty: Math.round((providerPenalty + costPenalty + authOrLimitPenalty) * 10) / 10,
    providerId: providerId || null,
    estimatedCostUsd: Number.isFinite(cost) ? cost : null,
    providerPenalty,
    costPenalty: Math.round(costPenalty * 10) / 10,
    authOrLimitPenalty,
  };
}

function scoreQualityRisk({ plan = null, manifest = null, finalReview = null, caseIndex = null, next = {} } = {}) {
  const checks = collectReviewChecks(finalReview);
  const issueText = [
    finalReview?.decision,
    finalReview?.summary,
    finalReview?.notes,
    finalReview?.reason,
    finalReview?.blockers,
    checks,
    plan?.semanticIntake,
    plan?.designReferenceSpec,
    manifest?.packageReview,
    manifest?.review,
    manifest?.warnings,
    caseIndex?.qualitySignals,
    next?.blocker,
  ].map((item) => {
    if (item === null || item === undefined) return '';
    if (typeof item === 'string') return item;
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }).join('\n').toLowerCase();

  const failingChecks = checks.filter((check) => {
    const status = text(check?.status || check?.decision || '').toLowerCase();
    return status && !['pass', 'ok', 'passed'].includes(status);
  }).length;
  const penalties = [];
  if (failingChecks) penalties.push(['non_pass_review_checks', clamp(failingChecks * 6, 0, 30)]);
  if (/professional_finish|template_filler|placeholder|low quality|低质|手搓|模板|粗糙/.test(issueText)) penalties.push(['professional_finish_risk', 28]);
  if (/ocr|text mismatch|主体|brand.*mismatch|文字.*不一致|错字|乱码/.test(issueText)) penalties.push(['subject_or_text_consistency_risk', 24]);
  if (/rejected|淘汰|negative|负例|buyer rejected/.test(issueText)) penalties.push(['rejection_feedback_risk', 22]);
  if (/manual_provider_submit_requires|providerid.?manual|manual-import|manual import/.test(issueText)) penalties.push(['manual_provenance_risk', 32]);
  if (/refund|退款/.test(issueText)) penalties.push(['refund_state_risk', 80]);
  if (/captcha|geetest|滑块|验证码/.test(issueText)) penalties.push(['captcha_risk', 18]);
  const penalty = penalties.reduce((sum, [, value]) => sum + value, 0);
  return {
    penalty: clamp(penalty, 0, 95),
    reasons: penalties.map(([code, value]) => ({ code, penalty: value })),
    failingChecks,
  };
}

export function scoreBusinessPriority({
  job = {},
  next = {},
  plan = null,
  manifest = null,
  finalReview = null,
  caseIndex = null,
  finalReviewCurrentOk = false,
  auditState = null,
  now = Date.now(),
} = {}) {
  const amount = parseMoneyAmount(job.amount || job.budget || job.price || job.reward);
  const amountScore = clamp(Math.log10(Math.max(1, amount)) * 14, 0, 45);
  const hours = deadlineHoursFromJob(job, now);
  const deadline = scoreDeadline(hours);
  const gate = scoreGate(next, {
    finalReviewCurrentOk,
  });
  const competition = scoreCompetition(job);
  const qualityRisk = scoreQualityRisk({ plan, manifest, finalReview, caseIndex, next });
  const costRisk = scoreCostRisk({ manifest, auditState });
  const blockerPenalty = next.blocker ? ({
    seller_verified_work_exists: 100,
    employer_refund_requested: 100,
    existing_verified_submission_requires_allow_resubmit: 85,
    live_limit_requires_more_local_files: 38,
    live_limit_requires_more_selected_files: 36,
    final_review_not_current: 32,
    final_review_current_files_required: 30,
    route_contract_final_count: 8,
    package_expected_count: 8,
    seller_login_required: 26,
    seller_session_required_public_xq_only: 24,
    exclusive_provider_only: 90,
    live_page_http_error: 24,
    missing_generation_manifest: 8,
    dryrun_only: 8,
    human_feedback_message_approval_required: 4,
    human_feedback_message_evidence_required: 4,
    human_feedback_not_observed: 6,
    human_feedback_output_required: 10,
    human_feedback_output_path_required: 16,
    human_feedback_output_file_missing: 18,
    human_feedback_output_not_file: 18,
    human_feedback_output_hash_required: 16,
    human_feedback_output_hash_mismatch: 20,
    human_feedback_qa_report_required: 10,
    human_feedback_qa_report_path_required: 16,
    human_feedback_qa_report_file_missing: 18,
    human_feedback_qa_report_not_file: 18,
    human_feedback_qa_report_hash_required: 16,
    human_feedback_qa_report_hash_mismatch: 20,
    human_feedback_artifact_naming_required: 10,
    human_feedback_human_review_pass_required: 12,
    human_feedback_session_blocked: 60,
  }[next.blocker] || 14) : 0;
  const rawScore = gate.score
    + amountScore
    + deadline.score
    + competition.score
    - qualityRisk.penalty
    - costRisk.penalty
    - blockerPenalty;
  const score = Math.round(clamp(rawScore, -100, 160) * 10) / 10;
  const decisionBand = score >= 105
    ? 'do_now'
    : score >= 78
      ? 'high_value'
      : score >= 45
        ? 'normal'
        : score >= 10
          ? 'low_priority'
          : 'avoid_or_blocked';
  const result = {
    version: BUSINESS_PRIORITY_SCORE_VERSION,
    score,
    decisionBand,
    amount,
    deadlineHours: hours === null ? null : Number(hours.toFixed(1)),
    factors: {
      gate,
      amountScore: Number(amountScore.toFixed(1)),
      deadline,
      competition,
      qualityRisk,
      costRisk,
      blockerPenalty,
    },
    summary: {
      gate: next.gate || null,
      blocker: next.blocker || null,
      finalReviewCurrentOk: Boolean(finalReviewCurrentOk),
    },
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
  return {
    ...result,
    priorityHash: digest(result),
  };
}

export function businessPriorityScoreSelftest() {
  const ready = scoreBusinessPriority({
    job: { taskId: 'ready', amount: '3000', deadline: new Date(Date.now() + 8 * 3600000).toISOString(), worksCount: 2 },
    next: { gate: 'submit_approval' },
    finalReview: { decision: 'pass', checks: [{ id: 'finish', status: 'pass' }] },
    caseIndex: { artifacts: [{ submitReady: true }] },
    finalReviewCurrentOk: true,
  });
  const rejected = scoreBusinessPriority({
    job: { taskId: 'bad', amount: '3000', deadline: new Date(Date.now() + 8 * 3600000).toISOString(), worksCount: 2 },
    next: { gate: 'submit_approval', blocker: 'final_review_not_current' },
    finalReview: { decision: 'review', checks: [{ id: 'professional_finish', status: 'fail', notes: 'template filler low quality 淘汰' }] },
    manifest: { provider: { providerId: 'manual' } },
    finalReviewCurrentOk: false,
  });
  const ok = ready.score > rejected.score
    && ready.decisionBand !== 'avoid_or_blocked'
    && ready.priorityHash?.startsWith('sha256:')
    && rejected.factors.qualityRisk.reasons.some((item) => item.code === 'professional_finish_risk')
    && rejected.factors.qualityRisk.reasons.some((item) => item.code === 'rejection_feedback_risk');
  return {
    ok,
    ready,
    rejected,
    safety: {
      localContractOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      fetchesChannelState: false,
      callsProviderOrModel: false,
      grantsExecutionPermission: false,
    },
  };
}
